# -*- coding: utf-8 -*-
"""Dispatcher for CSV Export button in UtilitiesPG.

This script acts as the UI launcher according to modular architecture rules.
All query logic lives in `lib/revit_queries/` and CSV export in `lib/csv_exporter/`.
"""
__title__ = "CSV Export"
__doc__ = """Version = 1.0
Date    = 26.10.2026
________________________________________________________________
Description:
Exports Rooms and Areas data to CSV.
Configurable delimiters, qualifiers, real-time parameter search,
Element ID export, and persistent presets.
________________________________________________________________
Author: Jos3PG"""

from pyrevit import revit, forms, coreutils
from csv_exporter.ui import CSVExportWindow
from csv_exporter.exporter import write_csv

logger = coreutils.logger.get_logger(__file__)
doc = revit.doc


def main():
    if not doc:
        forms.alert("No active Revit document found.", warn=True)
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

            cat_label = "rooms" if opts["category"] == "Rooms" else "areas"
            forms.alert(
                "Export completed successfully.\n\n"
                "Total {} exported: {}\n"
                "Parameters included: {}\n"
                "File path:\n{}".format(
                    cat_label,
                    exported_count,
                    len(opts["selected_params"]),
                    opts["filepath"]
                ),
                title="CSV Export - Completed"
            )

    except Exception as ex:
        logger.error("Error running CSV Export: {}".format(ex))
        forms.alert("An unexpected error occurred during CSV export:\n{}".format(ex), error=True)


if __name__ == "__main__":
    main()