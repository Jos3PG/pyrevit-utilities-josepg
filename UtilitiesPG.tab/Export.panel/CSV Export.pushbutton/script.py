# -*- coding: utf-8 -*-
"""Despachador del botón CSV Export en UtilitiesPG.

Este script actúa como lanzador de interfaz según las directrices de arquitectura modular.
Toda la lógica de consulta reside en `lib/revit_queries/` y la lógica de exportación en `lib/csv_exporter/`.
"""
__title__ = "CSV Export"
__doc__ = """Version = 1.0
Date    = 26.10.2026
________________________________________________________________
Description:
Exporta datos de Habitaciones (Rooms) y Áreas (Areas) a CSV.
Permite configurar delimitadores, calificadores, selección y búsqueda
de parámetros y gestión de presets.
________________________________________________________________
Author: Jos3PG"""

from pyrevit import revit, forms, coreutils
from csv_exporter.ui import CSVExportWindow
from csv_exporter.exporter import write_csv

logger = coreutils.logger.get_logger(__file__)
doc = revit.doc


def main():
    if not doc:
        forms.alert("No hay un documento activo de Revit abierto.", warn=True)
        return

    try:
        window = CSVExportWindow(doc)
        result = window.ShowDialog()

        if result:
            opts = window.get_export_options()
            if not opts:
                return

            exported_count = write_csv(
                filepath=opts["filepath"],
                doc=doc,
                elements=opts["elements"],
                param_names=opts["selected_params"],
                delimiter=opts["delimiter"],
                text_qualifier=opts["text_qualifier"],
                export_headers=opts["export_headers"]
            )

            cat_label = "habitaciones" if opts["category"] == "Rooms" else "áreas"
            forms.alert(
                "Exportación completada exitosamente.\n\n"
                "Total de {} exportadas: {}\n"
                "Parámetros incluidos: {}\n"
                "Ruta del archivo:\n{}".format(
                    cat_label,
                    exported_count,
                    len(opts["selected_params"]),
                    opts["filepath"]
                ),
                title="CSV Export - Completado"
            )

    except Exception as ex:
        logger.error("Error al ejecutar CSV Export: {}".format(ex))
        forms.alert("Ocurrió un error inesperado al exportar el archivo CSV:\n{}".format(ex), error=True)


if __name__ == "__main__":
    main()