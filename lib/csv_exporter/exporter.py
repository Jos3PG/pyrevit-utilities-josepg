# -*- coding: utf-8 -*-
"""Módulo de escritura de archivos CSV configurables con soporte UTF-8-SIG."""

import codecs
from revit_queries.spatial_elements import get_element_parameter_value

try:
    _text_type = unicode
except NameError:
    _text_type = str

DELIMITER_LOOKUP = {
    ";": ";",
    ",": ",",
    "Tab": "\t",
    "\\t": "\t",
    "|": "|"
}


def format_field(value, delimiter=";", text_qualifier="(none)"):
    """Formatea una celda individual según el calificador de texto y el delimitador.
    
    Args:
        value (str): Texto de la celda.
        delimiter (str): Carácter delimitador de columnas.
        text_qualifier (str): '(none)', '"' o "'".
        
    Returns:
        unicode: Texto formateado para el archivo CSV.
    """
    if value is None:
        value = u""
    else:
        try:
            if not isinstance(value, _text_type):
                value = _text_type(value)
        except Exception:
            value = _text_type(str(value))
            
    val_clean = value.replace(u"\r\n", u" ").replace(u"\n", u" ").replace(u"\r", u" ")

    if text_qualifier == u'"':
        escaped = val_clean.replace(u'"', u'""')
        return u'"{}"'.format(escaped)
        
    elif text_qualifier == u"'":
        escaped = val_clean.replace(u"'", u"''")
        return u"'{}'".format(escaped)
        
    else:
        # (none): si no hay calificador pero contiene el delimitador, eliminar o reemplazar por espacio
        # para no romper las columnas del CSV
        if delimiter in val_clean:
            val_clean = val_clean.replace(delimiter, u" ")
        return val_clean


def write_csv(filepath, doc, elements, param_names, delimiter=";", text_qualifier="(none)", export_headers=True):
    """Escribe la colección de elementos espaciales y sus parámetros en un archivo CSV.
    
    Args:
        filepath (str): Ruta completa al archivo CSV de destino.
        doc: Documento activo de Revit.
        elements (list): Lista de elementos de Revit (Rooms o Areas).
        param_names (list): Lista de nombres de parámetros a exportar.
        delimiter (str): Delimitador de campos (';', ',', 'Tab', '|').
        text_qualifier (str): Calificador de texto ('(none)', '"', "'").
        export_headers (bool): Si es True, escribe la fila de encabezados.
        
    Returns:
        int: Número de elementos exportados.
    """
    actual_delimiter = DELIMITER_LOOKUP.get(delimiter, ";")
    
    with codecs.open(filepath, "w", encoding="utf-8-sig") as f:
        # 1. Encabezados de columna
        if export_headers and param_names:
            header_cells = [
                format_field(name, actual_delimiter, text_qualifier)
                for name in param_names
            ]
            f.write(actual_delimiter.join(header_cells) + u"\r\n")

        # 2. Filas de datos
        count = 0
        for el in elements:
            row_cells = []
            for p_name in param_names:
                val = get_element_parameter_value(doc, el, p_name)
                row_cells.append(format_field(val, actual_delimiter, text_qualifier))
                
            f.write(actual_delimiter.join(row_cells) + u"\r\n")
            count += 1
            
    return count
