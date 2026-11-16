# -*- coding: utf-8 -*-
"""Controlador y Router de comunicación bidireccional WebView2 <-> Python/Revit.

Implementa:
1. Carga dinámica de ensamblados `Microsoft.Web.WebView2.Wpf` y `Microsoft.Web.WebView2.Core`
   compatible con .NET Framework 4.8 (Revit <= 2024) y .NET 8 (Revit 2025+).
2. Configuración segura de `UserDataFolder` en `%LOCALAPPDATA%` para evitar errores
   de permisos en `C:\\Program Files\\Autodesk\\Revit`.
3. Contrato JSON estandarizado:
   `{"action": "nombre_accion", "payload": {...}}`
"""

import os
import json
import codecs

try:
    import clr
    import System
    from pyrevit import coreutils
    logger = coreutils.logger.get_logger(__file__)
except ImportError:
    clr = None
    System = None
    logger = None


def ensure_webview2_assemblies():
    """Carga los ensamblados de WebView2 desde el entorno de pyRevit o del sistema."""
    if clr is None:
        return False

    try:
        clr.AddReference("Microsoft.Web.WebView2.Core")
        clr.AddReference("Microsoft.Web.WebView2.Wpf")
        return True
    except Exception:
        pass

    # Buscar en las rutas de binarios de pyRevit-Master (netcore o netfx según CLR actual)
    is_netcore = False
    try:
        is_netcore = System.Environment.Version.Major >= 5
    except Exception:
        pass

    subfolder = "netcore" if is_netcore else "netfx"
    appdata = os.getenv("APPDATA") or ""
    localappdata = os.getenv("LOCALAPPDATA") or ""
    programfiles = os.getenv("PROGRAMFILES") or "C:\\Program Files"

    candidate_dirs = [
        os.path.join(appdata, "pyRevit-Master", "bin", subfolder),
        os.path.join(localappdata, "pyRevit-Master", "bin", subfolder),
        os.path.join(programfiles, "pyRevit-Master", "bin", subfolder),
    ]

    for bin_dir in candidate_dirs:
        core_dll = os.path.join(bin_dir, "Microsoft.Web.WebView2.Core.dll")
        wpf_dll = os.path.join(bin_dir, "Microsoft.Web.WebView2.Wpf.dll")
        if os.path.exists(core_dll) and os.path.exists(wpf_dll):
            try:
                # Añadir bin_dir al PATH del proceso para que localice WebView2Loader.dll
                current_path = os.environ.get("PATH", "")
                if bin_dir not in current_path:
                    os.environ["PATH"] = bin_dir + os.pathsep + current_path
                clr.AddReferenceToFileAndPath(core_dll)
                clr.AddReferenceToFileAndPath(wpf_dll)
                return True
            except Exception as ex:
                if logger:
                    logger.debug("Fallo cargando WebView2 desde {}: {}".format(bin_dir, ex))

    return False


class WebView2Bridge(object):
    """Gestiona la instancia de WebView2 dentro de un contenedor WPF y enruta mensajes JSON."""

    def __init__(self, host_container, web_folder_path, on_ready_callback=None,
                 app_name="KeyScheduleManager", virtual_host="keyschedule.pyrevit.local"):
        """Inicializa el control WebView2 y lo inserta en el contenedor WPF indicado.

        Args:
            host_container: Control WPF (ej. Border o Grid) donde se alojará el WebView2.
            web_folder_path (str): Ruta absoluta a la carpeta con `index.html`, CSS y JS.
            on_ready_callback (callable): Función invocada cuando el frontend notifica `bridge_ready`.
            app_name (str): Nombre único para aislar la carpeta UserDataFolder en caché local.
            virtual_host (str): Nombre de host virtual de respaldo para assets locales.
        """
        self.host_container = host_container
        self.web_folder_path = web_folder_path
        self.on_ready_callback = on_ready_callback
        self.app_name = app_name
        self.virtual_host = virtual_host
        self.webview = None
        self.is_ready = False
        self._handlers = {}

        if not ensure_webview2_assemblies():
            raise RuntimeError(
                "No se pudieron cargar los ensamblados Microsoft.Web.WebView2. "
                "Verifica que WebView2 Runtime esté instalado."
            )

        from Microsoft.Web.WebView2.Wpf import WebView2, CoreWebView2CreationProperties

        self.webview = WebView2()

        # Configurar carpeta de caché de usuario en LOCALAPPDATA para evitar bloqueos de permisos
        base_temp = os.getenv("LOCALAPPDATA") or os.getenv("TEMP") or os.path.expanduser("~")
        user_data_folder = os.path.join(base_temp, "pyRevit_WebView2_Cache", self.app_name)
        if not os.path.exists(user_data_folder):
            try:
                os.makedirs(user_data_folder)
            except Exception:
                pass

        props = CoreWebView2CreationProperties()
        props.UserDataFolder = user_data_folder
        self.webview.CreationProperties = props

        # Suscribir eventos del ciclo de vida de WebView2
        self.webview.CoreWebView2InitializationCompleted += self._on_core_initialized
        self.webview.NavigationCompleted += self._on_navigation_completed

        # Insertar el control en el contenedor XAML
        self.host_container.Child = self.webview

        # Disparar la creación asíncrona del entorno CoreWebView2
        self.webview.EnsureCoreWebView2Async(None)

    def register_handler(self, action_name, callback):
        """Registra un manejador para una acción recibida desde JavaScript."""
        self._handlers[action_name] = callback

    def send_message(self, action_name, payload=None):
        """Envía un mensaje JSON estructurado hacia JavaScript en WebView2."""
        if not self.webview or not self.webview.CoreWebView2:
            return
        envelope = {
            "action": action_name,
            "payload": payload if payload is not None else {}
        }
        try:
            json_str = json.dumps(envelope, ensure_ascii=False)
            self.webview.CoreWebView2.PostWebMessageAsJson(json_str)
        except Exception as ex:
            if logger:
                logger.error("Error enviando mensaje JSON a WebView2: {}".format(ex))

    def _on_core_initialized(self, sender, args):
        """Se ejecuta cuando CoreWebView2 está listo para navegar."""
        if not args.IsSuccess:
            if logger:
                logger.error("Fallo en CoreWebView2InitializationCompleted: {}".format(args.InitializationException))
            return

        core = self.webview.CoreWebView2

        # Ajustes de interfaz del navegador embebido
        try:
            settings = core.Settings
            settings.AreDefaultContextMenusEnabled = False
            settings.IsStatusBarEnabled = False
            settings.IsZoomControlEnabled = True
        except Exception:
            pass

        # Escuchar mensajes enviados desde JS via window.chrome.webview.postMessage
        core.WebMessageReceived += self._on_web_message_received

        # Cargar interfaz web ensamblando HTML+CSS+JS frescos desde disco (evita caché de WebView2)
        try:
            html_content = self._build_inlined_html()
            core.NavigateToString(html_content)
        except Exception:
            from Microsoft.Web.WebView2.Core import CoreWebView2HostResourceAccessKind
            import time
            core.SetVirtualHostNameToFolderMapping(
                self.virtual_host,
                self.web_folder_path,
                CoreWebView2HostResourceAccessKind.Allow
            )
            core.Navigate("https://{}/index.html?t={}".format(self.virtual_host, int(time.time())))

    def _build_inlined_html(self):
        """Ensambla index.html junto con todos sus CSS y JS locales en un único documento."""
        import re
        index_path = os.path.join(self.web_folder_path, "index.html")
        if not os.path.exists(index_path):
            return ""

        with codecs.open(index_path, "r", "utf-8") as f:
            html = f.read()

        def replace_css(match):
            href = match.group(1).strip()
            css_path = os.path.join(self.web_folder_path, href)
            if os.path.exists(css_path):
                with codecs.open(css_path, "r", "utf-8") as cf:
                    return "<style>\n" + cf.read() + "\n</style>"
            return match.group(0)

        def replace_js(match):
            src = match.group(1).strip()
            js_path = os.path.join(self.web_folder_path, src)
            if os.path.exists(js_path):
                with codecs.open(js_path, "r", "utf-8") as jf:
                    return "<script>\n" + jf.read() + "\n</script>"
            return match.group(0)

        html = re.sub(r'<link\s+[^>]*rel=["\']stylesheet["\'][^>]*href=["\']([^"\']+)["\'][^>]*>', replace_css, html)
        html = re.sub(r'<script\s+[^>]*src=["\']([^"\']+)["\'][^>]*>\s*</script>', replace_js, html)
        return html

    def _on_navigation_completed(self, sender, args):
        """Notifica cuando el documento HTML terminó de cargar."""
        self.is_ready = True

    def _on_web_message_received(self, sender, args):
        """Recibe mensajes JSON desde el frontend JS y los despacha al handler registrado."""
        try:
            raw_json = args.WebMessageAsJson
            if not raw_json:
                try:
                    raw_json = args.TryGetWebMessageAsString()
                except Exception:
                    return

            message = json.loads(raw_json)
            # Si viene doblemente serializado como string JSON
            if isinstance(message, (str, getattr(__builtins__, "unicode", str))):
                message = json.loads(message)

            action = message.get("action")
            payload = message.get("payload", {})

            if action == "bridge_ready":
                if self.on_ready_callback:
                    self.on_ready_callback()
                return

            handler = self._handlers.get(action)
            if handler:
                handler(payload)
            else:
                if logger:
                    logger.debug("Acción no registrada en WebView2Bridge: {}".format(action))
        except Exception as ex:
            if logger:
                logger.error("Error procesando mensaje de WebView2: {}".format(ex))
            self.send_message("toast", {
                "type": "error",
                "message": "Error al procesar acción en Revit: {}".format(ex)
            })

    def dispose(self):
        """Libera recursos del control WebView2 al cerrar la ventana."""
        try:
            if self.webview is not None:
                self.webview.Dispose()
                self.webview = None
        except Exception:
            pass
