# -*- coding: utf-8 -*-
"""Controlador de la ventana WPF para la exportación de CSV en pyRevit."""

import os
import datetime
from pyrevit import forms, coreutils

# .NET Imports
import clr
clr.AddReference("PresentationFramework")
clr.AddReference("PresentationCore")
clr.AddReference("WindowsBase")
clr.AddReference("System")

from System.Windows import Thickness
from System.Windows.Controls import CheckBox, ComboBoxItem
from Microsoft.Win32 import SaveFileDialog

from revit_queries.spatial_elements import get_spatial_elements, get_available_parameters
from csv_exporter.presets import load_presets, save_preset, delete_preset

logger = coreutils.logger.get_logger(__file__)
XAML_PATH = os.path.join(os.path.dirname(__file__), "xaml", "CSVExportWindow.xaml")


class CSVExportWindow(forms.WPFWindow):
    """Ventana WPF para configurar y exportar CSV de Habitaciones y Áreas."""

    def __init__(self, doc):
        forms.WPFWindow.__init__(self, XAML_PATH)
        self.doc = doc
        self.export_options = None
        self.is_loading = True
        
        # Colecciones internas
        self.all_params = []
        self.selected_params = set()
        self.current_elements = []
        
        # 1. Conectar eventos de controles
        self.cb_Category.SelectionChanged += self.on_category_changed
        self.tb_SearchParam.TextChanged += self.on_search_changed
        self.btn_SelectAll.Click += self.on_select_all
        self.btn_DeselectAll.Click += self.on_deselect_all
        self.btn_Browse.Click += self.on_browse
        self.cb_Presets.SelectionChanged += self.on_preset_changed
        self.btn_SavePreset.Click += self.on_save_preset
        self.btn_DeletePreset.Click += self.on_delete_preset
        self.btn_Export.Click += self.on_export_click
        self.btn_Cancel.Click += self.on_cancel_click
        self.chk_IncludeLinks.Checked += self.on_links_option_changed
        self.chk_IncludeLinks.Unchecked += self.on_links_option_changed
        self.chk_ExcludeUnplaced.Checked += self.on_unplaced_option_changed
        self.chk_ExcludeUnplaced.Unchecked += self.on_unplaced_option_changed

        # 2. Inicializar opciones fijas
        self._init_comboboxes()

        # 3. Cargar presets
        self._populate_presets()

        # 4. Cargar categoría inicial (Rooms)
        self.is_loading = False
        self._load_category("Rooms")
        
        # 5. Aplicar preset inicial si existe
        self._apply_initial_preset()

    def _init_comboboxes(self):
        """Inicializa desplegables de categoría, delimitador y calificador."""
        # Categoría
        self.cb_Category.Items.Clear()
        for cat_name in ["Rooms (Habitaciones)", "Areas (Áreas)"]:
            item = ComboBoxItem()
            item.Content = cat_name
            item.Tag = "Rooms" if "Rooms" in cat_name else "Areas"
            self.cb_Category.Items.Add(item)
        self.cb_Category.SelectedIndex = 0

        # Delimitador de campo (según captura: ; por defecto)
        self.cb_Delimiter.Items.Clear()
        delimiters = [
            (";", "; (Punto y coma)"),
            (",", ", (Coma)"),
            ("Tab", "Tab (Tabulación)"),
            ("|", "| (Pleca / Barra)")
        ]
        for val, label in delimiters:
            item = ComboBoxItem()
            item.Content = label
            item.Tag = val
            self.cb_Delimiter.Items.Add(item)
        self.cb_Delimiter.SelectedIndex = 0

        # Calificador de texto (según captura: (none) por defecto)
        self.cb_TextQualifier.Items.Clear()
        qualifiers = [
            ("(none)", "(none) - Ninguno"),
            ('"', '" (Comillas dobles)'),
            ("'", "' (Comillas simples)")
        ]
        for val, label in qualifiers:
            item = ComboBoxItem()
            item.Content = label
            item.Tag = val
            self.cb_TextQualifier.Items.Add(item)
        self.cb_TextQualifier.SelectedIndex = 0

    def _populate_presets(self, select_name=None):
        """Llena el ComboBox de presets con los disponibles."""
        self.cb_Presets.Items.Clear()
        presets = load_presets()
        selected_index = 0

        idx = 0
        for name in sorted(presets.keys()):
            item = ComboBoxItem()
            item.Content = name
            item.Tag = name
            self.cb_Presets.Items.Add(item)
            if select_name and name == select_name:
                selected_index = idx
            idx += 1

        if self.cb_Presets.Items.Count > 0:
            self.cb_Presets.SelectedIndex = selected_index

    def _apply_initial_preset(self):
        """Aplica el primer preset disponible."""
        if self.cb_Presets.SelectedItem:
            self.on_preset_changed(None, None)

    def _get_current_category_tag(self):
        """Retorna 'Rooms' o 'Areas' según la selección actual."""
        selected = self.cb_Category.SelectedItem
        if selected:
            return selected.Tag
        return "Rooms"

    def _load_category(self, category_tag):
        """Recopila elementos y parámetros de la categoría seleccionada (Host y Vínculos)."""
        exclude_unplaced = bool(self.chk_ExcludeUnplaced.IsChecked)
        include_links = bool(self.chk_IncludeLinks.IsChecked)
        self.current_elements = get_spatial_elements(
            self.doc, 
            category_name=category_tag, 
            exclude_unplaced=exclude_unplaced,
            include_links=include_links
        )
        
        self.all_params = get_available_parameters(self.current_elements)
        
        # Sugerir ruta de guardado por defecto
        self._update_default_filepath(category_tag)
        
        # Refrescar vista de parámetros
        self._refresh_params_list()

    def _update_default_filepath(self, category_tag):
        """Genera una ruta sugerida en Documentos o Escritorio."""
        doc_title = "Modelo"
        try:
            if self.doc and self.doc.Title:
                doc_title = self.doc.Title.replace(".rvt", "")
        except Exception:
            pass
            
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M")
        cat_es = "Habitaciones" if category_tag == "Rooms" else "Areas"
        filename = "{}_{}_{}.csv".format(cat_es, doc_title, timestamp)
        
        docs_dir = os.path.join(os.getenv("USERPROFILE") or os.path.expanduser("~"), "Documents")
        if not os.path.exists(docs_dir):
            docs_dir = os.getenv("TEMP") or "."
            
        self.tb_FilePath.Text = os.path.join(docs_dir, filename)

    def _refresh_params_list(self):
        """Actualiza el ListBox de parámetros filtrando por el texto de búsqueda."""
        filter_text = (self.tb_SearchParam.Text or "").strip().lower()
        self.lb_Parameters.Items.Clear()

        for p_name in self.all_params:
            if not filter_text or filter_text in p_name.lower():
                cb = CheckBox()
                cb.Content = p_name
                cb.Tag = p_name
                cb.IsChecked = (p_name in self.selected_params)
                cb.Margin = Thickness(4, 3, 4, 3)
                cb.Checked += self._on_param_checked
                cb.Unchecked += self._on_param_unchecked
                self.lb_Parameters.Items.Add(cb)

        self._update_count_label()

    def _on_param_checked(self, sender, args):
        if sender and sender.Tag:
            self.selected_params.add(sender.Tag)
            self._update_count_label()

    def _on_param_unchecked(self, sender, args):
        if sender and sender.Tag:
            self.selected_params.discard(sender.Tag)
            self._update_count_label()

    def _update_count_label(self):
        total = len(self.all_params)
        selected = len(self.selected_params)
        elem_count = len(self.current_elements)
        self.lbl_ParamCount.Text = "{} de {} selec. ({} elem. encontrados)".format(
            selected, total, elem_count
        )

    # ---- Eventos de Interfaz -----------------------------------------------

    def on_category_changed(self, sender, args):
        if self.is_loading:
            return
        cat_tag = self._get_current_category_tag()
        self.selected_params.clear()
        self._load_category(cat_tag)

    def on_links_option_changed(self, sender, args):
        if self.is_loading:
            return
        cat_tag = self._get_current_category_tag()
        self._load_category(cat_tag)

    def on_unplaced_option_changed(self, sender, args):
        if self.is_loading:
            return
        cat_tag = self._get_current_category_tag()
        self._load_category(cat_tag)

    def on_search_changed(self, sender, args):
        self._refresh_params_list()

    def on_select_all(self, sender, args):
        filter_text = (self.tb_SearchParam.Text or "").strip().lower()
        for p_name in self.all_params:
            if not filter_text or filter_text in p_name.lower():
                self.selected_params.add(p_name)
        self._refresh_params_list()

    def on_deselect_all(self, sender, args):
        filter_text = (self.tb_SearchParam.Text or "").strip().lower()
        if not filter_text:
            self.selected_params.clear()
        else:
            for p_name in self.all_params:
                if filter_text in p_name.lower():
                    self.selected_params.discard(p_name)
        self._refresh_params_list()

    def on_browse(self, sender, args):
        sfd = SaveFileDialog()
        sfd.Title = "Seleccionar destino de exportación CSV"
        sfd.Filter = "Archivos CSV (*.csv)|*.csv|Todos los archivos (*.*)|*.*"
        sfd.DefaultExt = ".csv"
        
        current_path = self.tb_FilePath.Text
        if current_path:
            try:
                sfd.InitialDirectory = os.path.dirname(current_path)
                sfd.FileName = os.path.basename(current_path)
            except Exception:
                pass
                
        if sfd.ShowDialog() == True:
            self.tb_FilePath.Text = sfd.FileName

    # ---- Gestión de Presets ------------------------------------------------

    def on_preset_changed(self, sender, args):
        if not self.cb_Presets.SelectedItem:
            return
        preset_name = self.cb_Presets.SelectedItem.Tag
        presets = load_presets()
        if preset_name not in presets:
            return
            
        data = presets[preset_name]
        cat_name = data.get("category", "Rooms")
        
        # 1. Establecer categoría
        for i in range(self.cb_Category.Items.Count):
            if self.cb_Category.Items[i].Tag == cat_name:
                self.cb_Category.SelectedIndex = i
                break
                
        # 2. Recargar elementos de categoría
        self._load_category(cat_name)
        
        # 3. Establecer parámetros seleccionados
        preset_params = set(data.get("parameters", []))
        self.selected_params = set([p for p in self.all_params if p in preset_params])
        
        # 4. Delimitador
        target_delim = data.get("delimiter", ";")
        for i in range(self.cb_Delimiter.Items.Count):
            if self.cb_Delimiter.Items[i].Tag == target_delim:
                self.cb_Delimiter.SelectedIndex = i
                break
                
        # 5. Calificador de texto
        target_qual = data.get("text_qualifier", "(none)")
        for i in range(self.cb_TextQualifier.Items.Count):
            if self.cb_TextQualifier.Items[i].Tag == target_qual:
                self.cb_TextQualifier.SelectedIndex = i
                break
                
        # 6. Opciones de aspecto
        self.chk_Headers.IsChecked = data.get("export_headers", True)
        self.chk_ExcludeUnplaced.IsChecked = data.get("exclude_unplaced", True)
        self.chk_IncludeLinks.IsChecked = data.get("include_links", True)
        
        # Refrescar vista
        self._refresh_params_list()

    def on_save_preset(self, sender, args):
        name = forms.ask_for_string(
            prompt="Ingresa un nombre para el nuevo Preset:",
            title="Guardar Preset de Exportación"
        )
        if not name:
            return
            
        name = name.strip()
        selected_delim = self.cb_Delimiter.SelectedItem.Tag if self.cb_Delimiter.SelectedItem else ";"
        selected_qual = self.cb_TextQualifier.SelectedItem.Tag if self.cb_TextQualifier.SelectedItem else "(none)"
        
        config_data = {
            "category": self._get_current_category_tag(),
            "parameters": list(self.selected_params),
            "delimiter": selected_delim,
            "text_qualifier": selected_qual,
            "export_headers": bool(self.chk_Headers.IsChecked),
            "exclude_unplaced": bool(self.chk_ExcludeUnplaced.IsChecked),
            "include_links": bool(self.chk_IncludeLinks.IsChecked)
        }
        
        if save_preset(name, config_data):
            self._populate_presets(select_name=name)
            forms.alert("Preset '{}' guardado exitosamente.".format(name), title="Preset Guardado")
        else:
            forms.alert("No se pudo guardar el preset.", error=True)

    def on_delete_preset(self, sender, args):
        if not self.cb_Presets.SelectedItem:
            return
        name = self.cb_Presets.SelectedItem.Tag
        
        confirm = forms.alert(
            "¿Estás seguro de que deseas eliminar el preset '{}'?".format(name),
            title="Eliminar Preset",
            yes=True, no=True
        )
        if confirm:
            if delete_preset(name):
                self._populate_presets()
                self._apply_initial_preset()
            else:
                forms.alert("No se pudo eliminar el preset.", error=True)

    # ---- Acciones de Cierre y Validación -----------------------------------

    def on_export_click(self, sender, args):
        filepath = (self.tb_FilePath.Text or "").strip()
        if not filepath:
            forms.alert("Debes especificar una ruta de destino para el archivo CSV.", warn=True)
            return

        if not self.selected_params:
            forms.alert("Debes seleccionar al menos un parámetro para exportar.", warn=True)
            return

        if not self.current_elements:
            cat_tag = self._get_current_category_tag()
            name_cat = "Habitaciones" if cat_tag == "Rooms" else "Áreas"
            forms.alert(
                "No se encontraron {} en el modelo actual ni en los vínculos cargados.\n"
                "Asegúrate de que los vínculos estén cargados en el modelo federado.".format(name_cat),
                warn=True
            )
            return

        # Asegurar directorio de destino
        out_dir = os.path.dirname(filepath)
        if out_dir and not os.path.exists(out_dir):
            try:
                os.makedirs(out_dir)
            except Exception as ex:
                forms.alert("No se puede crear la carpeta de destino:\n{}".format(ex), error=True)
                return

        # Preparar opciones ordenando parámetros según lista original
        ordered_selected = [p for p in self.all_params if p in self.selected_params]
        delim = self.cb_Delimiter.SelectedItem.Tag if self.cb_Delimiter.SelectedItem else ";"
        qual = self.cb_TextQualifier.SelectedItem.Tag if self.cb_TextQualifier.SelectedItem else "(none)"

        self.export_options = {
            "filepath": filepath,
            "category": self._get_current_category_tag(),
            "elements": self.current_elements,
            "selected_params": ordered_selected,
            "delimiter": delim,
            "text_qualifier": qual,
            "export_headers": bool(self.chk_Headers.IsChecked),
            "export_title": bool(self.chk_ExportTitle.IsChecked),
            "include_links": bool(self.chk_IncludeLinks.IsChecked),
            "title_text": "Exportación de {}".format(
                "Habitaciones" if self._get_current_category_tag() == "Rooms" else "Áreas"
            )
        }

        self.DialogResult = True
        self.Close()

    def on_cancel_click(self, sender, args):
        self.DialogResult = False
        self.Close()

    def get_export_options(self):
        """Retorna las opciones de exportación seleccionadas."""
        return self.export_options