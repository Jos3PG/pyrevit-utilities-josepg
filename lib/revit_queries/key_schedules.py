# -*- coding: utf-8 -*-
"""Consultas y motor de edición transaccional para Key Schedules en Revit API.

Proporciona funciones desacopladas para:
1. Listar todas las Key Schedules del documento activo.
2. Extraer la definición completa (Campos, Agrupación/Orden), filas,
   metadatos de parámetros, métricas de uso en el modelo (KPIs) y elementos/habitaciones
   de la misma categoría sin clave/estilo asignado.
3. Aplicar cambios en lote (estructura de ScheduleDefinition + filas de Key Schedule +
   asignación de claves y edición de parámetros en habitaciones/elementos) dentro de un
   único TransactionGroup.
"""

try:
    from pyrevit import DB, revit, coreutils
    logger = coreutils.logger.get_logger(__file__)
except ImportError:
    DB = None
    revit = None
    logger = None


def get_id_val(element_id):
    """Obtiene el valor numérico entero de un ElementId o ScheduleFieldId (Revit 2021-2027)."""
    if element_id is None:
        return -1
    if isinstance(element_id, int):
        return element_id
    try:
        return int(getattr(element_id, "Value", getattr(element_id, "IntegerValue", -1)))
    except Exception:
        return -1


def make_element_id(int_val):
    """Crea un DB.ElementId compatible tanto con Revit <= 2023 (int) como Revit 2024+ (Int64)."""
    if DB is None:
        return int_val
    try:
        from System import Int64
        return DB.ElementId(Int64(int(int_val)))
    except Exception:
        try:
            return DB.ElementId(int(int_val))
        except Exception:
            return DB.ElementId.InvalidElementId


def get_all_key_schedules(doc):
    """Obtiene todas las tablas de planificación de claves (Key Schedules) del documento."""
    if not doc or not DB:
        return []

    schedules_data = []
    try:
        collector = (
            DB.FilteredElementCollector(doc)
            .OfClass(DB.ViewSchedule)
            .WhereElementIsNotElementType()
        )
        for sched in collector:
            try:
                if sched.IsTemplate:
                    continue
                sched_def = sched.Definition
                if not sched_def or not sched_def.IsKeySchedule:
                    continue

                cat_name = "General"
                cat_id = sched_def.CategoryId
                if cat_id and cat_id != DB.ElementId.InvalidElementId:
                    cat = DB.Category.GetCategory(doc, cat_id)
                    if cat and cat.Name:
                        cat_name = cat.Name

                key_param_name = getattr(sched, "KeyScheduleParameterName", "") or "Key Name"

                row_count = (
                    DB.FilteredElementCollector(doc, sched.Id)
                    .WhereElementIsNotElementType()
                    .GetElementCount()
                )

                schedules_data.append({
                    "id": get_id_val(sched.Id),
                    "name": sched.Name,
                    "category_name": cat_name,
                    "category_id": get_id_val(cat_id),
                    "key_param_name": key_param_name,
                    "row_count": row_count
                })
            except Exception as ex:
                if logger:
                    logger.debug("Error inspeccionando ViewSchedule: {}".format(ex))
                continue
    except Exception as ex:
        if logger:
            logger.error("Error al colectar Key Schedules: {}".format(ex))

    schedules_data.sort(key=lambda x: (x["category_name"].lower(), x["name"].lower()))
    return schedules_data


def _collect_all_key_row_ids_for_category(doc, category_id):
    """Recopila los ElementId de todas las filas internas de cualquier Key Schedule de la categoría."""
    all_key_ids = set()
    try:
        cat_val = get_id_val(category_id)
        for sched in DB.FilteredElementCollector(doc).OfClass(DB.ViewSchedule).WhereElementIsNotElementType():
            try:
                if sched.IsTemplate or not sched.Definition or not sched.Definition.IsKeySchedule:
                    continue
                if get_id_val(sched.Definition.CategoryId) == cat_val:
                    for eid in DB.FilteredElementCollector(doc, sched.Id).WhereElementIsNotElementType().ToElementIds():
                        all_key_ids.add(get_id_val(eid))
            except Exception:
                continue
    except Exception:
        pass
    return all_key_ids


def _extract_param_value_fast(doc, param):
    """Extrae el valor textual y tipo de un DB.Parameter ya localizado."""
    if param is None:
        return "", "String", True

    is_readonly = bool(param.IsReadOnly)
    st = param.StorageType

    if st == DB.StorageType.String:
        val = param.AsString() or ""
        return val, "String", is_readonly

    elif st == DB.StorageType.Integer:
        data_type_str = _get_param_datatype_kind(param)
        if data_type_str == "Boolean":
            int_val = param.AsInteger() if param.HasValue else 0
            return ("Yes" if int_val == 1 else "No"), "Boolean", is_readonly
        if not param.HasValue:
            return "", "Integer", is_readonly
        return str(param.AsInteger()), "Integer", is_readonly

    elif st == DB.StorageType.Double:
        if not param.HasValue:
            return "", "Double", is_readonly
        val_str = param.AsValueString()
        if val_str:
            return val_str, "Double", is_readonly
        return str(round(param.AsDouble(), 4)), "Double", is_readonly

    elif st == DB.StorageType.ElementId:
        if not param.HasValue:
            return "", "ElementId", is_readonly
        eid = param.AsElementId()
        if eid and eid != DB.ElementId.InvalidElementId:
            ref_el = doc.GetElement(eid)
            if ref_el and hasattr(ref_el, "Name") and ref_el.Name:
                return ref_el.Name, "ElementId", is_readonly
            val_str = param.AsValueString()
            if val_str:
                return val_str, "ElementId", is_readonly
            return str(get_id_val(eid)), "ElementId", is_readonly
        return "", "ElementId", is_readonly

    return "", "String", is_readonly


def _compute_usage_and_unassigned(doc, category_id, key_param_name, key_element_ids_set):
    """Calcula el mapa de usos en el modelo y recopila los elementos sin estilo/clave asignado.

    Returns:
        tuple: (usage_map, total_model_elements, unassigned_data_dict)
    """
    usage_map = {kid: 0 for kid in key_element_ids_set}
    total_model_elements = 0
    unassigned_rows = []
    available_params_map = {}  # param_name -> {"name": str, "is_readonly": bool, "storage_type": str}
    readonly_params_set = set(["ID"])

    cat_name = "Elementos"
    is_rooms_cat = False
    default_name_param = None

    if not doc or not category_id or category_id == DB.ElementId.InvalidElementId:
        return usage_map, 0, {
            "category_name": cat_name,
            "is_rooms_category": False,
            "key_param_name": key_param_name,
            "default_columns": ["ID", key_param_name],
            "available_params": [],
            "readonly_params": ["ID"],
            "rows": []
        }

    try:
        cat_obj = DB.Category.GetCategory(doc, category_id)
        if cat_obj and cat_obj.Name:
            cat_name = cat_obj.Name
        is_rooms_cat = (get_id_val(category_id) == int(DB.BuiltInCategory.OST_Rooms))
    except Exception:
        pass

    all_cat_key_row_ids = _collect_all_key_row_ids_for_category(doc, category_id)
    all_cat_key_row_ids.update(key_element_ids_set)

    # Identificar nombre local del parámetro "Name" / "Nombre" para Rooms o general
    room_name_bip = None
    try:
        if is_rooms_cat and hasattr(DB.BuiltInParameter, "ROOM_NAME"):
            room_name_bip = DB.BuiltInParameter.ROOM_NAME
    except Exception:
        room_name_bip = None

    try:
        collector = (
            DB.FilteredElementCollector(doc)
            .OfCategoryId(category_id)
            .WhereElementIsNotElementType()
        )
        for el in collector:
            el_id = get_id_val(el.Id)
            # Omitir las filas internas de Key Schedules (no son elementos físicos del modelo)
            if el_id in all_cat_key_row_ids or getattr(el, "Category", None) is None:
                continue

            total_model_elements += 1
            key_ref_id = -1
            key_param_obj = None

            if key_param_name:
                key_param_obj = el.LookupParameter(key_param_name)
                if key_param_obj and key_param_obj.StorageType == DB.StorageType.ElementId and key_param_obj.HasValue:
                    key_ref_id = get_id_val(key_param_obj.AsElementId())

            if key_ref_id not in usage_map:
                for p in el.Parameters:
                    try:
                        if p.StorageType == DB.StorageType.ElementId and p.HasValue:
                            cand_id = get_id_val(p.AsElementId())
                            if cand_id in usage_map:
                                key_ref_id = cand_id
                                break
                    except Exception:
                        continue

            if key_ref_id in usage_map:
                usage_map[key_ref_id] += 1
            else:
                # Este elemento NO tiene asignada ninguna clave de esta Key Schedule
                # Determinar nombre local del parámetro Name/Nombre la primera vez
                if default_name_param is None:
                    if room_name_bip is not None:
                        try:
                            rn_p = el.get_Parameter(room_name_bip)
                            if rn_p and rn_p.Definition and rn_p.Definition.Name:
                                default_name_param = rn_p.Definition.Name
                        except Exception:
                            pass
                    if default_name_param is None:
                        for cand_name in ("Name", "Nombre"):
                            if el.LookupParameter(cand_name):
                                default_name_param = cand_name
                                break

                cells = {
                    "ID": str(el_id),
                    key_param_name: ""
                }

                # Extraer parámetros del elemento no asignado
                for p in el.Parameters:
                    try:
                        if not p or not p.Definition or not p.Definition.Name:
                            continue
                        p_name = p.Definition.Name.strip()
                        if not p_name:
                            continue

                        val_str, st_type, is_ro = _extract_param_value_fast(doc, p)

                        # Si ya se registró como parámetro editable en otro parámetro homónimo, priorizar
                        if p_name not in cells or (p_name in readonly_params_set and not is_ro):
                            cells[p_name] = val_str

                        if p_name not in available_params_map:
                            available_params_map[p_name] = {
                                "name": p_name,
                                "is_readonly": is_ro,
                                "storage_type": st_type
                            }
                            if is_ro:
                                readonly_params_set.add(p_name)
                        elif not is_ro and available_params_map[p_name]["is_readonly"]:
                            available_params_map[p_name]["is_readonly"] = False
                            readonly_params_set.discard(p_name)
                    except Exception:
                        continue

                # Asegurar que el parámetro clave figure siempre aunque tenga valor vacío
                if key_param_name:
                    cells[key_param_name] = ""
                    if key_param_name not in available_params_map:
                        available_params_map[key_param_name] = {
                            "name": key_param_name,
                            "is_readonly": False,
                            "storage_type": "KeyRef"
                        }

                # Añadir también "Name" si es elemento sin parámetro explícito de nombre
                if default_name_param and default_name_param not in cells:
                    cells[default_name_param] = getattr(el, "Name", "") or ""

                unassigned_rows.append({
                    "row_id": "elem_" + str(el_id),
                    "element_id": el_id,
                    "cells": cells
                })

    except Exception as ex:
        if logger:
            logger.debug("Error calculando usos y elementos sin estilo: {}".format(ex))

    # Construir columnas por defecto: ID, Name/Nombre, Estilo de habitación (key_param_name)
    default_cols = ["ID"]
    if default_name_param:
        default_cols.append(default_name_param)
    elif "Name" in available_params_map:
        default_cols.append("Name")
    elif "Nombre" in available_params_map:
        default_cols.append("Nombre")

    if key_param_name and key_param_name not in default_cols:
        default_cols.append(key_param_name)

    # Asegurar que ID figura en available_params_map al principio o como opción
    if "ID" not in available_params_map:
        available_params_map["ID"] = {
            "name": "ID",
            "is_readonly": True,
            "storage_type": "String"
        }

    available_params_list = sorted(
        available_params_map.values(),
        key=lambda x: (0 if x["name"] in default_cols else 1, x["name"].lower())
    )

    # Ordenar filas sin estilo por ID numérico o Name
    unassigned_rows.sort(key=lambda r: (
        (r["cells"].get(default_name_param or "Name", "") or "").lower(),
        r["element_id"]
    ))

    unassigned_data = {
        "category_name": cat_name,
        "is_rooms_category": is_rooms_cat,
        "key_param_name": key_param_name,
        "default_columns": default_cols,
        "available_params": available_params_list,
        "readonly_params": sorted(list(readonly_params_set)),
        "rows": unassigned_rows
    }

    return usage_map, total_model_elements, unassigned_data


def _read_param_from_row(doc, row_elem, param_id_int, field_name):
    """Lee el valor actual y metadatos de un parámetro en una fila de Key Schedule."""
    param = None

    try:
        if param_id_int < 0:
            bip = System_Enum_ToObject_BuiltInParameter(param_id_int)
            if bip is not None:
                param = row_elem.get_Parameter(bip)
        if param is None and param_id_int != -1:
            for p in row_elem.Parameters:
                if p.Definition and get_id_val(p.Id) == param_id_int:
                    param = p
                    break
    except Exception:
        pass

    if param is None and field_name:
        param = row_elem.LookupParameter(field_name)
        if param is None:
            for p in row_elem.Parameters:
                if p.Definition and p.Definition.Name == field_name:
                    param = p
                    break

    return _extract_param_value_fast(doc, param)


def System_Enum_ToObject_BuiltInParameter(param_id_int):
    """Convierte un entero negativo en DB.BuiltInParameter de forma segura."""
    try:
        import System
        return System.Enum.ToObject(DB.BuiltInParameter, int(param_id_int))
    except Exception:
        return None


def _get_param_datatype_kind(param):
    """Detecta si un parámetro Integer es en realidad un Yes/No (Boolean)."""
    try:
        defn = param.Definition
        if hasattr(defn, "GetDataType"):
            dt = defn.GetDataType()
            if dt and hasattr(DB, "SpecTypeId") and hasattr(DB.SpecTypeId, "Boolean"):
                if dt == DB.SpecTypeId.Boolean.YesNo:
                    return "Boolean"
        if hasattr(defn, "ParameterType"):
            if str(defn.ParameterType) == "YesNo":
                return "Boolean"
    except Exception:
        pass
    return "Integer"


def get_key_schedule_details(doc, schedule_id_int):
    """Extrae toda la estructura y datos de una Key Schedule para cargar en WebView2."""
    sched = doc.GetElement(make_element_id(schedule_id_int))
    if not sched or not isinstance(sched, DB.ViewSchedule):
        raise ValueError("No se encontró la Key Schedule con ID {}.".format(schedule_id_int))

    sched_def = sched.Definition
    cat_id = sched_def.CategoryId
    cat_name = "General"
    if cat_id and cat_id != DB.ElementId.InvalidElementId:
        cat = DB.Category.GetCategory(doc, cat_id)
        if cat and cat.Name:
            cat_name = cat.Name

    key_param_name = getattr(sched, "KeyScheduleParameterName", "") or "Key Name"
    ref_table_bip_id = int(DB.BuiltInParameter.REF_TABLE_ELEM_NAME)

    # 1. Campos activos en la tabla (en su orden actual)
    active_fields = []
    field_id_to_key = {}
    active_param_ids = set()

    field_order = list(sched_def.GetFieldOrder())
    for order_idx, fid in enumerate(field_order):
        field = sched_def.GetField(fid)
        if not field:
            continue
        param_id_int = get_id_val(field.ParameterId)
        fid_int = get_id_val(fid)
        orig_name = field.GetName()
        heading = field.ColumnHeading or orig_name
        is_hidden = bool(field.IsHidden)
        is_key_name = (param_id_int == ref_table_bip_id) or (orig_name == key_param_name and order_idx == 0)

        field_key = "param_{}".format(param_id_int) if param_id_int != -1 else "field_{}".format(fid_int)
        field_id_to_key[fid_int] = field_key
        if param_id_int != -1:
            active_param_ids.add(param_id_int)

        active_fields.append({
            "key": field_key,
            "field_id": fid_int,
            "param_id": param_id_int,
            "name": orig_name,
            "heading": heading,
            "is_hidden": is_hidden,
            "is_key_name": is_key_name,
            "storage_type": "String"
        })

    # 2. Campos disponibles (SchedulableFields que aún no están en la tabla)
    available_fields = []
    seen_avail_param_ids = set()
    try:
        for sf in sched_def.GetSchedulableFields():
            try:
                p_id = get_id_val(sf.ParameterId)
                if p_id == -1 or p_id in active_param_ids or p_id in seen_avail_param_ids:
                    continue
                sf_name = sf.GetName(doc)
                if not sf_name:
                    continue
                seen_avail_param_ids.add(p_id)
                available_fields.append({
                    "key": "param_{}".format(p_id),
                    "param_id": p_id,
                    "name": sf_name,
                    "heading": sf_name,
                    "is_hidden": False,
                    "is_key_name": False,
                    "storage_type": "String"
                })
            except Exception:
                continue
    except Exception as ex:
        if logger:
            logger.debug("Error leyendo GetSchedulableFields: {}".format(ex))

    available_fields.sort(key=lambda x: x["name"].lower())

    # 3. Agrupación y Orden (ScheduleSortGroupField)
    sort_group_data = []
    try:
        for sg in sched_def.GetSortGroupFields():
            fid_int = get_id_val(sg.FieldId)
            field_key = field_id_to_key.get(fid_int, "")
            sort_ord = "Ascending" if sg.SortOrder == DB.ScheduleSortOrder.Ascending else "Descending"
            if field_key:
                sort_group_data.append({
                    "field_key": field_key,
                    "sort_order": sort_ord,
                    "show_header": bool(sg.ShowHeader),
                    "show_footer": bool(sg.ShowFooter),
                    "show_blank_line": bool(sg.ShowBlankLine)
                })
    except Exception as ex:
        if logger:
            logger.debug("Error extrayendo SortGroupFields: {}".format(ex))

    # 4. Elementos fila de la Key Schedule y elementos sin asignar en el modelo
    row_elements = list(
        DB.FilteredElementCollector(doc, sched.Id)
        .WhereElementIsNotElementType()
        .ToElements()
    )
    key_elem_ids_set = set(get_id_val(el.Id) for el in row_elements)

    usage_map, total_model_elements, unassigned_data = _compute_usage_and_unassigned(
        doc, cat_id, key_param_name, key_elem_ids_set
    )

    all_known_fields = active_fields + available_fields
    field_storage_detected = {}

    rows_data = []
    for row_el in row_elements:
        rid = get_id_val(row_el.Id)
        cells = {}
        for f_info in all_known_fields:
            f_key = f_info["key"]
            val_str, st_type, _ = _read_param_from_row(
                doc, row_el, f_info["param_id"], f_info["name"]
            )
            cells[f_key] = val_str
            if f_key not in field_storage_detected and st_type:
                field_storage_detected[f_key] = st_type

        rows_data.append({
            "row_id": str(rid),
            "element_id": rid,
            "is_new": False,
            "is_deleted": False,
            "usage_count": usage_map.get(rid, 0),
            "cells": cells
        })

    for f_info in all_known_fields:
        f_key = f_info["key"]
        if f_key in field_storage_detected:
            f_info["storage_type"] = field_storage_detected[f_key]

    if active_fields:
        first_key = active_fields[0]["key"]
        rows_data.sort(key=lambda r: (r["cells"].get(first_key, "") or "").lower())

    return {
        "schedule_id": get_id_val(sched.Id),
        "schedule_name": sched.Name,
        "category_name": cat_name,
        "key_param_name": key_param_name,
        "is_itemized": bool(sched_def.IsItemized),
        "active_fields": active_fields,
        "available_fields": available_fields,
        "sort_group": sort_group_data,
        "rows": rows_data,
        "total_model_elements": total_model_elements,
        "unassigned_data": unassigned_data
    }


def _write_param_to_row(doc, row_elem, param_id_int, field_name, raw_value):
    """Escribe un valor en el parámetro correspondiente de una fila o elemento de Revit."""
    param = None
    try:
        if param_id_int < 0 and param_id_int != -1:
            bip = System_Enum_ToObject_BuiltInParameter(param_id_int)
            if bip is not None:
                param = row_elem.get_Parameter(bip)
        if param is None and param_id_int != -1:
            for p in row_elem.Parameters:
                if p.Definition and get_id_val(p.Id) == param_id_int:
                    param = p
                    break
    except Exception:
        pass

    if param is None and field_name:
        param = row_elem.LookupParameter(field_name)
        if param is None or param.IsReadOnly:
            for p in row_elem.Parameters:
                if p.Definition and p.Definition.Name == field_name and not p.IsReadOnly:
                    param = p
                    break

    if param is None or param.IsReadOnly:
        return False

    val_str = "" if raw_value is None else str(raw_value).strip()
    st = param.StorageType

    try:
        if st == DB.StorageType.String:
            param.Set(val_str)
            return True

        elif st == DB.StorageType.Integer:
            if _get_param_datatype_kind(param) == "Boolean":
                truthy = val_str.lower() in ("1", "true", "yes", "sí", "si", "s", "y")
                param.Set(1 if truthy else 0)
                return True
            if val_str == "":
                param.Set(0)
                return True
            param.Set(int(float(val_str)))
            return True

        elif st == DB.StorageType.Double:
            if val_str == "":
                param.Set(0.0)
                return True
            if not param.SetValueString(val_str):
                clean_num = val_str.split(" ")[0].replace(",", ".")
                param.Set(float(clean_num))
            return True

        elif st == DB.StorageType.ElementId:
            if val_str == "" or val_str.lower() in ("(none)", "ninguno", "(sin asignar)", "-1"):
                param.Set(DB.ElementId.InvalidElementId)
                return True
            try:
                eid_num = int(val_str)
                param.Set(make_element_id(eid_num))
                return True
            except ValueError:
                pass
    except Exception as ex:
        if logger:
            logger.debug("Error escribiendo parámetro '{}': {}".format(field_name, ex))
    return False


def apply_key_schedule_changes(doc, schedule_id_int, payload):
    """Aplica cambios de Key Schedule (definición + filas) y asignaciones/ediciones de elementos sin estilo."""
    sched = doc.GetElement(make_element_id(schedule_id_int))
    if not sched or not isinstance(sched, DB.ViewSchedule):
        raise ValueError("No se encontró la Key Schedule para aplicar los cambios.")

    sched_def = sched.Definition
    key_param_name = getattr(sched, "KeyScheduleParameterName", "") or "Key Name"
    desired_fields = payload.get("active_fields", [])
    desired_sort_group = payload.get("sort_group", [])
    desired_itemized = bool(payload.get("is_itemized", True))
    rows_payload = payload.get("rows", [])
    unassigned_updates = payload.get("unassigned_updates", [])

    stats = {
        "inserted": 0,
        "updated": 0,
        "deleted": 0,
        "elements_updated": 0,
        "fields_updated": False
    }

    tg = DB.TransactionGroup(doc, "Key Schedule Manager - Aplicar Cambios")
    tg.Start()

    try:
        # =====================================================================
        # PASO 1: Actualizar estructura de ScheduleDefinition (Campos, Orden, Agrupación)
        # =====================================================================
        with revit.Transaction("Actualizar estructura de Key Schedule", doc=doc):
            current_order = list(sched_def.GetFieldOrder())
            param_to_fid = {}
            for fid in current_order:
                f_obj = sched_def.GetField(fid)
                if f_obj:
                    p_id = get_id_val(f_obj.ParameterId)
                    param_to_fid[p_id] = fid

            avail_sf_map = {}
            for sf in sched_def.GetSchedulableFields():
                p_id = get_id_val(sf.ParameterId)
                if p_id != -1 and p_id not in avail_sf_map:
                    avail_sf_map[p_id] = sf

            desired_param_ids = [int(f["param_id"]) for f in desired_fields if int(f.get("param_id", -1)) != -1]
            desired_param_set = set(desired_param_ids)
            ref_table_bip_id = int(DB.BuiltInParameter.REF_TABLE_ELEM_NAME)

            for p_id, fid in list(param_to_fid.items()):
                if p_id not in desired_param_set and p_id != ref_table_bip_id:
                    try:
                        sched_def.RemoveField(fid)
                        del param_to_fid[p_id]
                        stats["fields_updated"] = True
                    except Exception as ex:
                        if logger:
                            logger.debug("No se pudo quitar el campo {}: {}".format(p_id, ex))

            for f_info in desired_fields:
                p_id = int(f_info.get("param_id", -1))
                if p_id != -1 and p_id not in param_to_fid and p_id in avail_sf_map:
                    try:
                        new_field = sched_def.AddField(avail_sf_map[p_id])
                        param_to_fid[p_id] = new_field.FieldId
                        stats["fields_updated"] = True
                    except Exception as ex:
                        if logger:
                            logger.debug("No se pudo añadir el campo {}: {}".format(p_id, ex))

            new_field_order = []
            key_to_field_obj = {}
            for f_info in desired_fields:
                p_id = int(f_info.get("param_id", -1))
                fid = param_to_fid.get(p_id)
                if fid is not None:
                    new_field_order.append(fid)
                    f_obj = sched_def.GetField(fid)
                    if f_obj:
                        key_to_field_obj[f_info["key"]] = f_obj
                        new_heading = (f_info.get("heading") or f_info.get("name") or "").strip()
                        if new_heading and f_obj.ColumnHeading != new_heading:
                            try:
                                f_obj.ColumnHeading = new_heading
                            except Exception:
                                pass
                        want_hidden = bool(f_info.get("is_hidden", False))
                        if f_obj.IsHidden != want_hidden:
                            try:
                                f_obj.IsHidden = want_hidden
                            except Exception:
                                pass

            if len(new_field_order) == sched_def.GetFieldCount():
                try:
                    from System.Collections.Generic import List
                    typed_list = List[DB.ScheduleFieldId](new_field_order)
                    sched_def.SetFieldOrder(typed_list)
                except Exception:
                    try:
                        sched_def.SetFieldOrder(new_field_order)
                    except Exception:
                        pass

            try:
                sched_def.ClearSortGroupFields()
                for sg_item in desired_sort_group:
                    f_key = sg_item.get("field_key")
                    f_obj = key_to_field_obj.get(f_key)
                    if not f_obj:
                        continue
                    order_enum = (
                        DB.ScheduleSortOrder.Descending
                        if sg_item.get("sort_order") == "Descending"
                        else DB.ScheduleSortOrder.Ascending
                    )
                    sg_field = DB.ScheduleSortGroupField(f_obj.FieldId, order_enum)
                    sg_field.ShowHeader = bool(sg_item.get("show_header", False))
                    sg_field.ShowFooter = bool(sg_item.get("show_footer", False))
                    sg_field.ShowBlankLine = bool(sg_item.get("show_blank_line", False))
                    sched_def.AddSortGroupField(sg_field)

                sched_def.IsItemized = desired_itemized
            except Exception as ex:
                if logger:
                    logger.debug("Error actualizando SortGroupFields: {}".format(ex))

        # =====================================================================
        # PASO 2: Eliminar filas marcadas, Insertar filas nuevas y Actualizar celdas
        # =====================================================================
        with revit.Transaction("Actualizar filas y datos de Key Schedule", doc=doc):
            rows_to_delete = [
                r for r in rows_payload
                if r.get("is_deleted") and not r.get("is_new") and r.get("element_id", -1) != -1
            ]
            for r_del in rows_to_delete:
                try:
                    eid = make_element_id(int(r_del["element_id"]))
                    if doc.GetElement(eid) is not None:
                        doc.Delete(eid)
                        stats["deleted"] += 1
                except Exception as ex:
                    if logger:
                        logger.debug("No se pudo eliminar la fila {}: {}".format(r_del.get("element_id"), ex))

            new_rows = [
                r for r in rows_payload
                if r.get("is_new") and not r.get("is_deleted")
            ]

            known_ids = set(
                get_id_val(eid)
                for eid in DB.FilteredElementCollector(doc, sched.Id)
                .WhereElementIsNotElementType()
                .ToElementIds()
            )

            created_row_elements = []
            if new_rows:
                table_data = sched.GetTableData()
                body_sec = table_data.GetSectionData(DB.SectionType.Body)

                for _ in new_rows:
                    inserted_ok = False
                    for candidate_idx in (body_sec.FirstRowNumber, body_sec.LastRowNumber, 0):
                        try:
                            body_sec.InsertRow(candidate_idx)
                            inserted_ok = True
                            break
                        except Exception:
                            continue

                    if inserted_ok:
                        doc.Regenerate()
                        current_ids = set(
                            get_id_val(eid)
                            for eid in DB.FilteredElementCollector(doc, sched.Id)
                            .WhereElementIsNotElementType()
                            .ToElementIds()
                        )
                        diff_ids = current_ids - known_ids
                        if diff_ids:
                            new_id = list(diff_ids)[0]
                            known_ids.add(new_id)
                            created_row_elements.append(doc.GetElement(make_element_id(new_id)))
                            stats["inserted"] += 1

            all_fields_meta = {f["key"]: f for f in desired_fields}

            for idx, r_new in enumerate(new_rows):
                if idx >= len(created_row_elements):
                    break
                row_el = created_row_elements[idx]
                if not row_el:
                    continue
                cells = r_new.get("cells", {})
                for f_key, val in cells.items():
                    f_meta = all_fields_meta.get(f_key)
                    if f_meta:
                        _write_param_to_row(doc, row_el, int(f_meta["param_id"]), f_meta["name"], val)

            existing_rows = [
                r for r in rows_payload
                if not r.get("is_new") and not r.get("is_deleted") and r.get("is_modified")
            ]
            for r_mod in existing_rows:
                eid_int = int(r_mod.get("element_id", -1))
                if eid_int == -1:
                    continue
                row_el = doc.GetElement(make_element_id(eid_int))
                if not row_el:
                    continue
                cells = r_mod.get("cells", {})
                modified_keys = r_mod.get("modified_keys", list(cells.keys()))
                any_written = False
                for f_key in modified_keys:
                    if f_key in cells and f_key in all_fields_meta:
                        f_meta = all_fields_meta[f_key]
                        if _write_param_to_row(doc, row_el, int(f_meta["param_id"]), f_meta["name"], cells[f_key]):
                            any_written = True
                if any_written:
                    stats["updated"] += 1

        # =====================================================================
        # PASO 3: Asignar Estilos y actualizar parámetros en Habitaciones/Elementos sin estilo
        # =====================================================================
        if unassigned_updates:
            with revit.Transaction("Asignar estilos y actualizar parámetros de elementos", doc=doc):
                doc.Regenerate()
                key_name_to_eid = {}
                key_bip = System_Enum_ToObject_BuiltInParameter(int(DB.BuiltInParameter.REF_TABLE_ELEM_NAME))

                for k_el in DB.FilteredElementCollector(doc, sched.Id).WhereElementIsNotElementType():
                    k_name_val = ""
                    if key_bip is not None:
                        p_kn = k_el.get_Parameter(key_bip)
                        if p_kn:
                            k_name_val = (p_kn.AsString() or "").strip()
                    if not k_name_val:
                        p_kn2 = k_el.LookupParameter("Key Name") or k_el.LookupParameter("Nombre de clave")
                        if p_kn2:
                            k_name_val = (p_kn2.AsString() or "").strip()
                    if not k_name_val and hasattr(k_el, "Name") and k_el.Name:
                        k_name_val = k_el.Name.strip()

                    if k_name_val:
                        key_name_to_eid[k_name_val.lower()] = k_el.Id

                for upd in unassigned_updates:
                    el_id = int(upd.get("element_id", -1))
                    mod_params = upd.get("modified_params", {})
                    if el_id == -1 or not mod_params:
                        continue
                    el = doc.GetElement(make_element_id(el_id))
                    if not el:
                        continue

                    el_changed = False
                    for p_name, new_val in mod_params.items():
                        if p_name == "ID":
                            continue
                        val_str = "" if new_val is None else str(new_val).strip()

                        if p_name == key_param_name:
                            p_key = el.LookupParameter(key_param_name)
                            if p_key and not p_key.IsReadOnly and p_key.StorageType == DB.StorageType.ElementId:
                                if val_str == "" or val_str.lower() in ("(sin asignar)", "(ninguno)", "ninguno"):
                                    p_key.Set(DB.ElementId.InvalidElementId)
                                    el_changed = True
                                else:
                                    target_eid = key_name_to_eid.get(val_str.lower())
                                    if target_eid is not None:
                                        p_key.Set(target_eid)
                                        el_changed = True
                        else:
                            if _write_param_to_row(doc, el, -1, p_name, val_str):
                                el_changed = True

                    if el_changed:
                        stats["elements_updated"] += 1

        tg.Assimilate()
    except Exception as ex:
        try:
            tg.RollBack()
        except Exception:
            pass
        raise ex

    return stats
