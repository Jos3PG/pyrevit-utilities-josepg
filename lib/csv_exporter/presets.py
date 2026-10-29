# -*- coding: utf-8 -*-
"""Gestión de presets de configuración de exportación CSV (persistencia en JSON)."""

import os
import json
import codecs

DEFAULT_PRESETS = {
    "Habitaciones - Básico": {
        "category": "Rooms",
        "parameters": [
            "Number", "Número", 
            "Name", "Nombre", 
            "Level", "Nivel", 
            "Area", "Área", 
            "Perimeter", "Perímetro",
            "Comments", "Comentarios"
        ],
        "delimiter": ";",
        "text_qualifier": "(none)",
        "export_headers": True,
        "exclude_unplaced": True,
        "include_links": True
    },
    "Habitaciones - Acabados y Datos": {
        "category": "Rooms",
        "parameters": [
            "Revit Link",
            "Number", "Número", 
            "Name", "Nombre", 
            "Level", "Nivel", 
            "Area", "Área", 
            "Base Finish", "Acabado de base",
            "Ceiling Finish", "Acabado de techo",
            "Wall Finish", "Acabado de muro",
            "Floor Finish", "Acabado de suelo",
            "Department", "Departamento",
            "Comments", "Comentarios"
        ],
        "delimiter": ";",
        "text_qualifier": "(none)",
        "export_headers": True,
        "exclude_unplaced": True,
        "include_links": True
    },
    "Áreas - Básico": {
        "category": "Areas",
        "parameters": [
            "Number", "Número", 
            "Name", "Nombre", 
            "Level", "Nivel", 
            "Area", "Área", 
            "Perimeter", "Perímetro",
            "Comments", "Comentarios"
        ],
        "delimiter": ";",
        "text_qualifier": "(none)",
        "export_headers": True,
        "exclude_unplaced": True,
        "include_links": True
    }
}


def get_user_preset_dir():
    """Retorna el directorio de configuración en AppData para UtilitiesPG."""
    appdata = os.getenv("APPDATA") or os.path.expanduser("~")
    target_dir = os.path.join(appdata, "pyRevit", "UtilitiesPG")
    if not os.path.exists(target_dir):
        try:
            os.makedirs(target_dir)
        except Exception:
            pass
    return target_dir


def get_presets_file_path():
    """Retorna la ruta completa al archivo presets.json."""
    return os.path.join(get_user_preset_dir(), "csv_export_presets.json")


def load_presets():
    """Carga los presets guardados desde JSON, o inicializa con los predeterminados.
    
    Returns:
        dict: Diccionario {nombre_preset: datos_preset}.
    """
    file_path = get_presets_file_path()
    presets = dict(DEFAULT_PRESETS)
    
    if os.path.exists(file_path):
        try:
            with codecs.open(file_path, "r", "utf-8") as f:
                user_presets = json.load(f)
                if isinstance(user_presets, dict):
                    presets.update(user_presets)
        except Exception:
            pass
            
    return presets


def save_preset(name, config_dict):
    """Guarda un preset individual en el archivo JSON.
    
    Args:
        name (str): Nombre del preset.
        config_dict (dict): Configuración del preset.
        
    Returns:
        bool: True si se guardó correctamente.
    """
    if not name or not config_dict:
        return False
        
    file_path = get_presets_file_path()
    presets = load_presets()
    presets[name] = config_dict
    
    try:
        with codecs.open(file_path, "w", "utf-8") as f:
            json.dump(presets, f, indent=2, ensure_ascii=False)
        return True
    except Exception:
        return False


def delete_preset(name):
    """Elimina un preset por nombre.
    
    Args:
        name (str): Nombre del preset.
        
    Returns:
        bool: True si se eliminó correctamente.
    """
    if not name:
        return False
        
    file_path = get_presets_file_path()
    presets = load_presets()
    
    if name in presets:
        del presets[name]
        try:
            with codecs.open(file_path, "w", "utf-8") as f:
                json.dump(presets, f, indent=2, ensure_ascii=False)
            return True
        except Exception:
            return False
            
    return False