# -*- coding: utf-8 -*-
"""Dispatcher for Key Schedule Manager button in UtilitiesPG.

Acts strictly as the UI launcher according to modular architecture rules.
All query and transaction logic lives in `lib/revit_queries/key_schedules.py`
and the WebView2 UI controller lives in `lib/key_schedule_manager/ui.py`.
"""
__title__ = "Key Schedule\nManager"
__doc__ = """Version = 1.0
Date    = 12.11.2026
________________________________________________________________
Description:
Interactive Key Schedule Manager powered by WebView2.
- Edit Schedule Fields, Revit Filters, and Sorting/Grouping in top tabs.
- Live Staging Preview before committing changes to Revit.
- Real-time KPIs (Total Keys, In-Use vs. Orphan Keys, Data Completeness).
- Find & Replace with live cell diff preview.
- Insert, duplicate, and paste rows directly from Excel (Ctrl+V).
- Global search and per-field filtering.
________________________________________________________________
Author: Jos3PG"""

from pyrevit import revit, forms, coreutils
from revit_queries.key_schedules import get_all_key_schedules
from key_schedule_manager.ui import KeyScheduleManagerWindow

logger = coreutils.logger.get_logger(__file__)
doc = revit.doc


def main():
    if not doc:
        forms.alert("No se encontró un documento activo de Revit.", warn=True)
        return

    try:
        schedules = get_all_key_schedules(doc)
        if not schedules:
            forms.alert(
                "No se encontraron Tablas de Claves (Key Schedules) en el modelo actual.\n\n"
                "Crea primero una Key Schedule en Revit (Vista > Tablas de planificación > Claves de tabla) "
                "para poder gestionarla con esta herramienta.",
                title="Key Schedule Manager",
                warn=True
            )
            return

        window = KeyScheduleManagerWindow(doc)
        window.ShowDialog()

    except Exception as ex:
        logger.error("Error ejecutando Key Schedule Manager: {}".format(ex))
        forms.alert(
            "Ocurrió un error inesperado al abrir Key Schedule Manager:\n{}".format(ex),
            title="Key Schedule Manager - Error",
            error=True
        )


if __name__ == "__main__":
    main()
