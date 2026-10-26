# -*- coding: utf-8 -*-
"""Consultas y extracción de datos para Habitaciones (Rooms) y Áreas (Areas)."""

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
    DB = _MockDB()

CATEGORY_MAP = {
    "Rooms": DB.BuiltInCategory.OST_Rooms,
    "Habitaciones": DB.BuiltInCategory.OST_Rooms,
    "Areas": DB.BuiltInCategory.OST_Areas,
    "Áreas": DB.BuiltInCategory.OST_Areas,
}


def get_spatial_elements(doc, category_name="Rooms", exclude_unplaced=True):
    """Obtiene elementos espaciales (Habitaciones o Áreas) del documento.
    
    Args:
        doc: Documento activo de Revit.
        category_name: 'Rooms' o 'Areas'.
        exclude_unplaced: Si es True, omite elementos no colocados o redundantes.
        
    Returns:
        list: Lista de elementos de Revit (SpatialElement).
    """
    cat = CATEGORY_MAP.get(category_name, DB.BuiltInCategory.OST_Rooms)
    
    collector = (
        DB.FilteredElementCollector(doc)
        .OfCategory(cat)
        .WhereElementIsNotElementType()
    )
    
    elements = list(collector.ToElements())
    
    if exclude_unplaced:
        filtered = []
        for el in elements:
            try:
                # Comprobar si el elemento está colocado y tiene área válida (> 0)
                if el.Location is not None and getattr(el, "Area", 0) > 0:
                    filtered.append(el)
            except Exception:
                # Si falla la propiedad Location o Area, omitir elemento no válido
                pass
        return filtered
        
    return elements


def get_available_parameters(elements):
    """Obtiene los nombres únicos de todos los parámetros disponibles en los elementos dados.
    
    Args:
        elements: Lista de elementos de Revit.
        
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
            
    # Asegurar parámetros comunes estándar si no fueron capturados
    # y ordenar alfabéticamente
    sorted_names = sorted(list(param_names), key=lambda x: x.lower())
    return sorted_names


def get_element_parameter_value(doc, element, param_name):
    """Extrae el valor formateado de un parámetro en un elemento espacial.
    
    Args:
        doc: Documento de Revit.
        element: Elemento de Revit.
        param_name: Nombre del parámetro a extraer.
        
    Returns:
        str: Valor en formato texto o cadena vacía.
    """
    if not element or not param_name:
        return ""
        
    try:
        # Atajos directos para propiedades nativas de SpatialElement
        p_lower = param_name.lower()
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

        param = element.LookupParameter(param_name)
        if not param:
            # Buscar en la colección de parámetros
            for p in element.Parameters:
                if p.Definition and p.Definition.Name == param_name:
                    param = p
                    break
                    
        if not param or not param.HasValue:
            # Si es el parámetro Level y no tenía HasValue directo
            if param_name.lower() in ("level", "nivel"):
                lvl_id = getattr(element, "LevelId", None)
                if lvl_id and lvl_id != DB.ElementId.InvalidElementId:
                    lvl = doc.GetElement(lvl_id)
                    if lvl:
                        return lvl.Name
            return ""

        storage_type = param.StorageType
        
        # 1. Intentar obtener el valor formateado según unidades de Revit (m², m, etc.)
        val_str = param.AsValueString()
        if val_str:
            return val_str.strip()
            
        # 2. Según tipo de almacenamiento
        if storage_type == DB.StorageType.String:
            s = param.AsString()
            return s.strip() if s else ""
            
        elif storage_type == DB.StorageType.Integer:
            return str(param.AsInteger())
            
        elif storage_type == DB.StorageType.Double:
            # Si AsValueString() no devolvió nada, formatear a decimal estándar
            return "{:.2f}".format(param.AsDouble())
            
        elif storage_type == DB.StorageType.ElementId:
            eid = param.AsElementId()
            if eid and eid != DB.ElementId.InvalidElementId:
                ref_el = doc.GetElement(eid)
                if ref_el and hasattr(ref_el, "Name") and ref_el.Name:
                    return ref_el.Name
                try:
                    # Revit 2024+ usa eid.Value (Int64), versiones anteriores IntegerValue (Int32)
                    return str(getattr(eid, "Value", getattr(eid, "IntegerValue", "")))
                except Exception:
                    return ""
            return ""
            
    except Exception:
        return ""
        
    return ""
