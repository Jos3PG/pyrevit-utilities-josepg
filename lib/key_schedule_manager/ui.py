# -*- coding: utf-8 -*-
"""Controlador de ventana WPF + WebView2 para Key Schedule Manager."""

import os
from pyrevit import forms, coreutils

from bim_bridge.webview_bridge import WebView2Bridge
from revit_queries.key_schedules import (
    get_all_key_schedules,
    get_key_schedule_details,
    apply_key_schedule_changes,
    get_id_val
)

logger = coreutils.logger.get_logger(__file__)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
XAML_PATH = os.path.join(BASE_DIR, "xaml", "KeyScheduleWindow.xaml")
WEB_DIR = os.path.join(BASE_DIR, "web")


class KeyScheduleManagerWindow(forms.WPFWindow):
    """Ventana anfitriona WPF que aloja el dashboard interactivo en WebView2."""

    def __init__(self, doc):
        forms.WPFWindow.__init__(self, XAML_PATH, handle_esc=False)
        self.doc = doc
        self.schedules_list = get_all_key_schedules(doc)
        self.initial_schedule_id = self._detect_initial_schedule_id()

        self.Closing += self.on_window_closing

        # Inicializar Bridge WebView2
        self.bridge = WebView2Bridge(
            host_container=self.WebViewHost,
            web_folder_path=WEB_DIR,
            on_ready_callback=self.on_frontend_ready
        )

        # Registrar acciones del contrato JSON
        self.bridge.register_handler("load_schedule", self.handle_load_schedule)
        self.bridge.register_handler("apply_changes", self.handle_apply_changes)
        self.bridge.register_handler("refresh_schedules", self.handle_refresh_schedules)
        self.bridge.register_handler("close_window", self.handle_close_window)

    def handle_input_key(self, sender, args):
        """Deshabilita el cierre automático con Escape de pyRevit WPFWindow."""
        pass

    def _detect_initial_schedule_id(self):
        """Si la vista activa en Revit es una Key Schedule, la selecciona por defecto."""
        try:
            active_view = self.doc.ActiveView
            if active_view:
                active_id = get_id_val(active_view.Id)
                for s in self.schedules_list:
                    if s["id"] == active_id:
                        return active_id
        except Exception:
            pass
        if self.schedules_list:
            return self.schedules_list[0]["id"]
        return None

    def on_frontend_ready(self):
        """Envía el listado inicial de Key Schedules y carga la primera tabla seleccionada."""
        self.bridge.send_message("init_data", {
            "schedules": self.schedules_list,
            "selected_schedule_id": self.initial_schedule_id
        })
        if self.initial_schedule_id is not None:
            self.handle_load_schedule({"schedule_id": self.initial_schedule_id})

    def handle_refresh_schedules(self, payload):
        """Refresca el listado de Key Schedules del modelo."""
        try:
            self.schedules_list = get_all_key_schedules(self.doc)
            current_id = payload.get("schedule_id") or self.initial_schedule_id
            self.bridge.send_message("init_data", {
                "schedules": self.schedules_list,
                "selected_schedule_id": current_id
            })
            if current_id is not None:
                self.handle_load_schedule({"schedule_id": current_id})
        except Exception as ex:
            logger.error("Error refrescando Key Schedules: {}".format(ex))
            self.bridge.send_message("toast", {
                "type": "error",
                "message": "No se pudo refrescar la lista de tablas: {}".format(ex)
            })

    def handle_load_schedule(self, payload):
        """Carga la estructura completa (Campos, Filtros, Orden) y las filas de una Key Schedule."""
        schedule_id = payload.get("schedule_id")
        if schedule_id is None:
            return
        try:
            details = get_key_schedule_details(self.doc, int(schedule_id))
            self.bridge.send_message("schedule_loaded", details)
        except Exception as ex:
            logger.error("Error al cargar Key Schedule {}: {}".format(schedule_id, ex))
            self.bridge.send_message("toast", {
                "type": "error",
                "message": "Error al leer la Key Schedule: {}".format(ex)
            })

    def handle_apply_changes(self, payload):
        """Aplica los cambios acumulados en previsualización dentro de Revit y recarga la tabla."""
        schedule_id = payload.get("schedule_id")
        if schedule_id is None:
            return
        try:
            stats = apply_key_schedule_changes(self.doc, int(schedule_id), payload)
            # Actualizar lista general (por si cambió el número de filas) y recargar detalles frescos
            self.schedules_list = get_all_key_schedules(self.doc)
            updated_details = get_key_schedule_details(self.doc, int(schedule_id))

            self.bridge.send_message("changes_applied", {
                "stats": stats,
                "schedules": self.schedules_list,
                "schedule_details": updated_details
            })
        except Exception as ex:
            logger.error("Error aplicando cambios en Key Schedule {}: {}".format(schedule_id, ex))
            self.bridge.send_message("toast", {
                "type": "error",
                "message": "Error al aplicar cambios en Revit: {}".format(ex)
            })

    def handle_close_window(self, payload):
        """Cierra la ventana de la herramienta."""
        self.Close()

    def on_window_closing(self, sender, args):
        """Limpia la instancia de WebView2 al cerrar la ventana."""
        if hasattr(self, "bridge") and self.bridge:
            self.bridge.dispose()
