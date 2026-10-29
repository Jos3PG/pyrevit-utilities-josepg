# -*- coding: utf-8 -*-
"""Consultas y extracción de datos para Habitaciones (Rooms) y Áreas (Areas).

Soporta modelos locales y modelos federados con vínculos (RevitLinkInstance).
"""

try:
    from pyrevit import DB
except ImportError:
    class _MockDB(object):
        class BuiltInCategory:
            OST_Rooms = "OST_Rooms"
            OST_Areas = "OST_Areas"
        class StorageType:
            String = 0
            Integer = 1
            Double = 2
            ElementId = 3
        class ElementId:
            InvalidElementId = -1
        class RevitLinkInstance(object):
            pass
    DB = _MockDB()

CATEGORY_MAP = {
    "Rooms": DB.BuiltInCategory.OST_Rooms,
    "Habitaciones": DB.BuiltInCategory.OST_Rooms,
    "Areas": DB.BuiltInCategory.OST_Areas,
    "Áreas": DB.BuiltInCategory.OST_Areas,
}

# Mapa para rastrear el modelo de procedencia de cada elemento (Host o nombre del vínculo)
_ELEMENT_LINK_MAP = {}


def get_spatial_elements(doc, category_name="Rooms", exclude_unplaced=True, include_links=True):
    """Obtiene elementos espaciales (Habitaciones o Áreas) del documento y/o de sus vínculos.
    
    Args:
        doc: Documento activo de Revit (Host).
        category_name: 'Rooms' o 'Areas'.
        exclude_unplaced: Si es True, omite elementos no colocados o sin área (> 0).
        include_links: Si es True, busca también en todos los modelos vinculados cargados.
        
    Returns:
        list: Lista de elementos de Revit (SpatialElement) encontrados.
    """
    global _ELEMENT_LINK_MAP
    _ELEMENT_LINK_MAP.clear()
    
    cat = CATEGORY_MAP.get(category_name, DB.BuiltInCategory.OST_Rooms)
    all_elements = []
    
    # 1. Recopilar elementos del modelo actual (Host)
    try:
        host_collector = (
            DB.FilteredElementCollector(doc)
            .OfCategory(cat)
            .WhereElementIsNotElementType()
        )
        host_elems = list(host_collector.ToElements())
        for el in host_elems:
            try:
                _ELEMENT_LINK_MAP[el.UniqueId] = "Host (Modelo Actual)"
            except Exception:
                pass
        all_elements.extend(host_elems)
    except Exception:
        pass
        
    # 2. Recopilar elementos de modelos vinculados (Revit Links) si está activo
    if include_links:
        try:
            link_instances = (
                DB.FilteredElementCollector(doc)
                .OfClass(DB.RevitLinkInstance)
                .ToElements()
            )
            seen_link_titles = set()
            
            for link_inst in link_instances:
                try:
                    link_doc = link_inst.GetLinkDocument()
                    if not link_doc:
                        continue
                        
                    # Evitar procesar el mismo archivo de vínculo más de una vez
                    link_title = link_doc.Title
                    if link_title in seen_link_titles:
                        continue
                    seen_link_titles.add(link_title)
                    
                    # Nombre amigable del vínculo
                    link_display_name = link_inst.Name.split(" : ")[0] if " : " in link_inst.Name else link_title
                    
                    link_collector = (
                        DB.FilteredElementCollector(link_doc)
                        .OfCategory(cat)
                        .WhereElementIsNotElementType()
                    )
                    link_elems = list(link_collector.ToElements())
                    for el in link_elems:
                        try:
                            _ELEMENT_LINK_MAP[el.UniqueId] = link_display_name
                        except Exception:
                            pass
                    all_elements.extend(link_elems)
                except Exception:
                    continue
        except Exception:
            pass

    # 3. Filtrar elementos no colocados si se solicita
    if exclude_unplaced:
        filtered = []
        for el in all_elements:
            try:
                # Comprobar si el elemento está colocado y tiene área válida (> 0)
                if el.Location is not None and getattr(el, "Area", 0) > 0:
                    filtered.append(el)
            except Exception:
                pass
        return filtered
        
    return all_elements


def get_available_parameters(elements):
    """Obtiene los nombres únicos de todos los parámetros disponibles en los elementos dados.
    
    Args:
        elements: Lista de elementos de Revit (Rooms o Areas).
        
    Returns:
        list: Lista ordenada de nombres de parámetros únicos.
    """
    param_names = set()
    
    for el in elements:
        if not el:
            continue
        try:
            for p in el.Parameters:
                if p and p.Definition and p.Definition.Name:
                    p_name = p.Definition.Name.strip()
                    if p_name:
                        param_names.add(p_name)
        except Exception:
            continue
            
    # Añadir columna virtual 'Revit Link' si hay elementos recopilados
    if elements:
        param_names.add("Revit Link")

    sorted_names = sorted(list(param_names), key=lambda x: x.lower())
    return sorted_names


def get_element_parameter_value(doc, element, param_name):
    """Extrae el valor formateado de un parámetro en un elemento espacial (Host o Vínculo).
    
    Args:
        doc: Documento de Revit.
        element: Elemento de Revit (SpatialElement).
        param_name: Nombre del parámetro a extraer.
        
    Returns:
        str: Valor en formato texto o cadena vacía.
    """
    if not element or not param_name:
        return ""
        
    # Obtener el documento nativo al que pertenece el elemento (soporta vínculos)
    elem_doc = getattr(element, "Document", None) or doc
    
    try:
        p_lower = param_name.lower()
        
        # 1. Columna virtual para el nombre del modelo o vínculo
        if p_lower in ("revit link", "vínculo", "vinculo", "modelo vínculo", "link name"):
            return _ELEMENT_LINK_MAP.get(getattr(element, "UniqueId", ""), getattr(elem_doc, "Title", ""))

        # 2. Atajos directos para propiedades nativas de SpatialElement
        if p_lower in ("level", "nivel") and getattr(element, "Level", None):
            return getattr(element.Level, "Name", "") or ""

        if p_lower in ("number", "número", "numero") and hasattr(element, "Number"):
            val = getattr(element, "Number", "")
            if val:
                return str(val)

        if p_lower in ("name", "nombre") and hasattr(element, "Name"):
            val = getattr(element, "Name", "")
            if val:
                return str(val)

        # 3. Búsqueda de parámetro en el elemento
        param = element.LookupParameter(param_name)
        if not param:
            for p in element.Parameters:
                if p.Definition and p.Definition.Name == param_name:
                    param = p
                    break
                    
        if not param or not param.HasValue:
            # Fallback para Level si no se obtuvo directamente
            if p_lower in ("level", "nivel"):
                lvl_id = getattr(element, "LevelId", None)
                if lvl_id and lvl_id != DB.ElementId.InvalidElementId:
                    lvl = elem_doc.GetElement(lvl_id)
                    if lvl:
                        return lvl.Name
            return ""

        storage_type = param.StorageType
        
        # 4. Formateo según unidades de Revit (m², m, etc.)
        val_str = param.AsValueString()
        if val_str:
            return val_str.strip()
            
        # 5. Formateo según tipo de almacenamiento
        if storage_type == DB.StorageType.String:
            s = param.AsString()
            return s.strip() if s else ""
            
        elif storage_type == DB.StorageType.Integer:
            return str(param.AsInteger())
            
        elif storage_type == DB.StorageType.Double:
            return "{:.2f}".format(param.AsDouble())
            
        elif storage_type == DB.StorageType.ElementId:
            eid = param.AsElementId()
            if eid and eid != DB.ElementId.InvalidElementId:
                # Usar elem_doc (el documento del vínculo) para resolver el ElementId
                ref_el = elem_doc.GetElement(eid)
                if ref_el and hasattr(ref_el, "Name") and ref_el.Name:
                    return ref_el.Name
                try:
                    return str(getattr(eid, "Value", getattr(eid, "IntegerValue", "")))
                except Exception:
                    return ""
            return ""
            
    except Exception:
        return ""
        
    return ""