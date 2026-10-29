# -*- coding: utf-8 -*-
"""Presets configuration and management for CSV Export (JSON persistence)."""

import os
import json
import codecs

DEFAULT_PRESETS = {
    "Rooms - Basic": {
        "category": "Rooms",
        "parameters": [
            "Element ID", "ID",
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
        "include_links": True,
        "filepath": ""
    },
    "Rooms - Finishes & Data": {
        "category": "Rooms",
        "parameters": [
            "Element ID", "ID",
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
        "include_links": True,
        "filepath": ""
    },
    "Areas - Basic": {
        "category": "Areas",
        "parameters": [
            "Element ID", "ID",
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
        "include_links": True,
        "filepath": ""
    }
}


def get_user_preset_dir():
    """Returns the configuration directory in AppData for UtilitiesPG, with local fallback."""
    appdata = os.getenv("APPDATA")
    if appdata:
        target_dir = os.path.join(appdata, "pyRevit", "UtilitiesPG")
        try:
            if not os.path.exists(target_dir):
                os.makedirs(target_dir)
            # Test write access
            test_file = os.path.join(target_dir, ".write_test")
            with open(test_file, "w") as f:
                f.write("")
            if os.path.exists(test_file):
                os.remove(test_file)
            return target_dir
        except Exception:
            pass
            
    # Fallback to module directory if AppData is not writable
    return os.path.dirname(os.path.abspath(__file__))


def get_presets_file_path():
    """Returns the full path to the presets.json file."""
    return os.path.join(get_user_preset_dir(), "csv_export_presets.json")


def load_presets():
    """Loads saved presets from JSON, falling back to defaults if none exist.
    
    Returns:
        dict: Dictionary of {preset_name: preset_data}.
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
    """Saves an individual preset to the JSON file.
    
    Args:
        name (str): Preset name.
        config_dict (dict): Preset configuration data.
        
    Returns:
        bool: True if saved successfully.
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
    """Deletes a preset by name.
    
    Args:
        name (str): Preset name.
        
    Returns:
        bool: True if deleted successfully.
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