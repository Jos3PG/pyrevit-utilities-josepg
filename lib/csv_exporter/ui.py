# -*- coding: utf-8 -*-
"""WPF Window controller for CSV Export in pyRevit (English UI)."""

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
    """WPF Window to configure and export Rooms and Areas to CSV."""

    def __init__(self, doc):
        forms.WPFWindow.__init__(self, XAML_PATH)
        self.doc = doc
        self.export_options = None
        self.is_loading = True
        
        # Internal collections
        self.all_params = []
        self.selected_params = set()
        self.current_elements = []
        self.filter_selected_only = False
        
        # 1. Connect control events
        self.cb_Category.SelectionChanged += self.on_category_changed
        self.tb_SearchParam.TextChanged += self.on_search_changed
        self.btn_FilterSelected.Click += self.on_toggle_filter_selected
        self.btn_SelectAll.Click += self.on_select_all
        self.btn_DeselectAll.Click += self.on_deselect_all
        self.btn_Browse.Click += self.on_browse
        self.cb_Presets.SelectionChanged += self.on_preset_changed
        self.btn_SavePreset.Click += self.on_save_preset
        self.btn_NewPreset.Click += self.on_new_preset
        self.btn_LoadPreset.Click += self.on_load_preset
        self.btn_DeletePreset.Click += self.on_delete_preset
        self.btn_Export.Click += self.on_export_click
        self.btn_Cancel.Click += self.on_cancel_click
        self.chk_IncludeLinks.Checked += self.on_links_option_changed
        self.chk_IncludeLinks.Unchecked += self.on_links_option_changed
        self.chk_ExcludeUnplaced.Checked += self.on_unplaced_option_changed
        self.chk_ExcludeUnplaced.Unchecked += self.on_unplaced_option_changed

        # 2. Initialize dropdowns
        self._init_comboboxes()

        # 3. Load presets
        self._populate_presets()

        # 4. Load initial category (Rooms)
        self.is_loading = False
        self._load_category("Rooms")
        
        # 5. Apply initial preset if available
        self._apply_initial_preset()

    def _init_comboboxes(self):
        """Initializes Category, Field Delimiter, and Text Qualifier dropdowns."""
        # Category
        self.cb_Category.Items.Clear()
        for cat_name in ["Rooms", "Areas"]:
            item = ComboBoxItem()
            item.Content = cat_name
            item.Tag = cat_name
            self.cb_Category.Items.Add(item)
        self.cb_Category.SelectedIndex = 0

        # Field delimiter (Default: ; as in Revit Export Schedule)
        self.cb_Delimiter.Items.Clear()
        delimiters = [
            (";", "; (Semicolon)"),
            (",", ", (Comma)"),
            ("Tab", "Tab (Tabulation)"),
            ("|", "| (Pipe)")
        ]
        for val, label in delimiters:
            item = ComboBoxItem()
            item.Content = label
            item.Tag = val
            self.cb_Delimiter.Items.Add(item)
        self.cb_Delimiter.SelectedIndex = 0

        # Text qualifier (Default: (none))
        self.cb_TextQualifier.Items.Clear()
        qualifiers = [
            ("(none)", "(none)"),
            ('"', '" (Double Quotes)'),
            ("'", "' (Single Quotes)")
        ]
        for val, label in qualifiers:
            item = ComboBoxItem()
            item.Content = label
            item.Tag = val
            self.cb_TextQualifier.Items.Add(item)
        self.cb_TextQualifier.SelectedIndex = 0

    def _populate_presets(self, select_name=None):
        """Populates the Presets ComboBox."""
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
        """Applies the first available preset."""
        if self.cb_Presets.SelectedItem:
            self.on_preset_changed(None, None)

    def _get_current_category_tag(self):
        """Returns 'Rooms' or 'Areas' according to current selection."""
        selected = self.cb_Category.SelectedItem
        if selected:
            return selected.Tag
        return "Rooms"

    def _reset_filter_selected(self):
        """Resets the 'Filter Selected' toggle to default off state."""
        self.filter_selected_only = False
        try:
            self.btn_FilterSelected.Content = "Filter Selected"
            self.btn_FilterSelected.ToolTip = "Show only selected parameters"
        except Exception:
            pass

    def _load_category(self, category_tag):
        """Collects elements and available parameters for the selected category."""
        self._reset_filter_selected()
        exclude_unplaced = bool(self.chk_ExcludeUnplaced.IsChecked)
        include_links = bool(self.chk_IncludeLinks.IsChecked)
        self.current_elements = get_spatial_elements(
            self.doc, 
            category_name=category_tag, 
            exclude_unplaced=exclude_unplaced,
            include_links=include_links
        )
        
        self.all_params = get_available_parameters(self.current_elements)
        
        # Suggest default export file path if none set
        if not (self.tb_FilePath.Text or "").strip():
            self._update_default_filepath(category_tag)
        
        # Refresh parameter list view
        self._refresh_params_list()

    def _update_default_filepath(self, category_tag):
        """Generates a default suggested file path in Documents."""
        doc_title = "Model"
        try:
            if self.doc and self.doc.Title:
                doc_title = self.doc.Title.replace(".rvt", "")
        except Exception:
            pass
            
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M")
        filename = "{}_{}_{}.csv".format(category_tag, doc_title, timestamp)
        
        docs_dir = os.path.join(os.getenv("USERPROFILE") or os.path.expanduser("~"), "Documents")
        if not os.path.exists(docs_dir):
            docs_dir = os.getenv("TEMP") or "."
            
        self.tb_FilePath.Text = os.path.join(docs_dir, filename)

    def _refresh_params_list(self):
        """Updates the ListBox filtering items based on search and selected toggle."""
        filter_text = (self.tb_SearchParam.Text or "").strip().lower()
        self.lb_Parameters.Items.Clear()

        for p_name in self.all_params:
            if self.filter_selected_only and p_name not in self.selected_params:
                continue
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
        filtered_tag = " [Filtered]" if self.filter_selected_only else ""
        self.lbl_ParamCount.Text = "{}{} of {} selected ({} elements found)".format(
            selected, filtered_tag, total, elem_count
        )

    # ---- UI Event Handlers -------------------------------------------------

    def on_toggle_filter_selected(self, sender, args):
        """Toggles between showing only selected parameters and showing all parameters."""
        if not self.filter_selected_only:
            if not self.selected_params:
                forms.alert("No parameters are currently selected to filter.", warn=True)
                return
            self.filter_selected_only = True
            self.btn_FilterSelected.Content = "Show All"
            self.btn_FilterSelected.ToolTip = "Show all available parameters"
        else:
            self.filter_selected_only = False
            self.btn_FilterSelected.Content = "Filter Selected"
            self.btn_FilterSelected.ToolTip = "Show only selected parameters"
        self._refresh_params_list()

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
            if self.filter_selected_only and p_name not in self.selected_params:
                continue
            if not filter_text or filter_text in p_name.lower():
                self.selected_params.add(p_name)
        self._refresh_params_list()

    def on_deselect_all(self, sender, args):
        filter_text = (self.tb_SearchParam.Text or "").strip().lower()
        if not filter_text:
            self.selected_params.clear()
        else:
            for p_name in self.all_params:
                if self.filter_selected_only and p_name not in self.selected_params:
                    continue
                if filter_text in p_name.lower():
                    self.selected_params.discard(p_name)
        if self.filter_selected_only and not self.selected_params:
            self._reset_filter_selected()
        self._refresh_params_list()

    def on_browse(self, sender, args):
        sfd = SaveFileDialog()
        sfd.Title = "Select CSV Destination File"
        sfd.Filter = "CSV Files (*.csv)|*.csv|All Files (*.*)|*.*"
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

    # ---- Preset Management -------------------------------------------------

    def on_preset_changed(self, sender, args):
        """Loads and applies settings from the selected preset."""
        if not self.cb_Presets.SelectedItem:
            return
        preset_name = self.cb_Presets.SelectedItem.Tag
        presets = load_presets()
        if preset_name not in presets:
            return
            
        data = presets[preset_name]
        cat_name = data.get("category", "Rooms")
        
        # 1. Set Category
        for i in range(self.cb_Category.Items.Count):
            if self.cb_Category.Items[i].Tag == cat_name:
                self.cb_Category.SelectedIndex = i
                break
                
        # 2. Reload elements for category
        self._load_category(cat_name)
        
        # 3. Restore selected parameters
        preset_params = set(data.get("parameters", []))
        self.selected_params = set([p for p in self.all_params if p in preset_params])
        
        # 4. Restore Field Delimiter
        target_delim = data.get("delimiter", ";")
        for i in range(self.cb_Delimiter.Items.Count):
            if self.cb_Delimiter.Items[i].Tag == target_delim:
                self.cb_Delimiter.SelectedIndex = i
                break
                
        # 5. Restore Text Qualifier
        target_qual = data.get("text_qualifier", "(none)")
        for i in range(self.cb_TextQualifier.Items.Count):
            if self.cb_TextQualifier.Items[i].Tag == target_qual:
                self.cb_TextQualifier.SelectedIndex = i
                break
                
        # 6. Restore Appearance Checkboxes
        self.chk_Headers.IsChecked = data.get("export_headers", True)
        self.chk_ExcludeUnplaced.IsChecked = data.get("exclude_unplaced", True)
        self.chk_IncludeLinks.IsChecked = data.get("include_links", True)
        
        # 7. Restore Filepath if saved in preset
        saved_path = (data.get("filepath") or "").strip()
        if saved_path:
            self.tb_FilePath.Text = saved_path
        else:
            self._update_default_filepath(cat_name)

        # Refresh parameter list view
        self._refresh_params_list()

    def on_save_preset(self, sender, args):
        """Saves / overwrites modifications to the currently selected preset."""
        if not self.cb_Presets.SelectedItem:
            self.on_new_preset(sender, args)
            return

        name = self.cb_Presets.SelectedItem.Tag
        selected_delim = self.cb_Delimiter.SelectedItem.Tag if self.cb_Delimiter.SelectedItem else ";"
        selected_qual = self.cb_TextQualifier.SelectedItem.Tag if self.cb_TextQualifier.SelectedItem else "(none)"
        current_filepath = (self.tb_FilePath.Text or "").strip()

        config_data = {
            "category": self._get_current_category_tag(),
            "parameters": list(self.selected_params),
            "delimiter": selected_delim,
            "text_qualifier": selected_qual,
            "export_headers": bool(self.chk_Headers.IsChecked),
            "exclude_unplaced": bool(self.chk_ExcludeUnplaced.IsChecked),
            "include_links": bool(self.chk_IncludeLinks.IsChecked),
            "filepath": current_filepath
        }

        if save_preset(name, config_data):
            forms.alert("Changes saved to preset '{}'.".format(name), title="Preset Saved")
        else:
            forms.alert("Could not save preset.", error=True)

    def on_new_preset(self, sender, args):
        """Creates a new preset requesting a name from user."""
        name = forms.ask_for_string(
            prompt="Enter a name for the new Preset:",
            title="New Export Preset"
        )
        if not name:
            return

        name = name.strip()
        selected_delim = self.cb_Delimiter.SelectedItem.Tag if self.cb_Delimiter.SelectedItem else ";"
        selected_qual = self.cb_TextQualifier.SelectedItem.Tag if self.cb_TextQualifier.SelectedItem else "(none)"
        current_filepath = (self.tb_FilePath.Text or "").strip()

        config_data = {
            "category": self._get_current_category_tag(),
            "parameters": list(self.selected_params),
            "delimiter": selected_delim,
            "text_qualifier": selected_qual,
            "export_headers": bool(self.chk_Headers.IsChecked),
            "exclude_unplaced": bool(self.chk_ExcludeUnplaced.IsChecked),
            "include_links": bool(self.chk_IncludeLinks.IsChecked),
            "filepath": current_filepath
        }

        if save_preset(name, config_data):
            self._populate_presets(select_name=name)
            forms.alert("Preset '{}' created successfully.".format(name), title="Preset Created")
        else:
            forms.alert("Could not create preset.", error=True)

    def on_load_preset(self, sender, args):
        """Reloads the saved configuration of the selected preset."""
        if not self.cb_Presets.SelectedItem:
            return
        name = self.cb_Presets.SelectedItem.Tag
        self.on_preset_changed(sender, args)
        forms.alert("Preset '{}' reloaded successfully.".format(name), title="Preset Loaded")

    def on_delete_preset(self, sender, args):
        """Deletes the currently selected preset after confirmation."""
        if not self.cb_Presets.SelectedItem:
            return
        name = self.cb_Presets.SelectedItem.Tag
        
        confirm = forms.alert(
            "Are you sure you want to delete preset '{}'?".format(name),
            title="Delete Preset",
            yes=True, no=True
        )
        if confirm:
            if delete_preset(name):
                self._populate_presets()
                self._apply_initial_preset()
            else:
                forms.alert("Could not delete preset.", error=True)

    # ---- Validation & Dialog Result ----------------------------------------

    def on_export_click(self, sender, args):
        filepath = (self.tb_FilePath.Text or "").strip()
        if not filepath:
            forms.alert("Please specify a destination path for the CSV file.", warn=True)
            return

        if not self.selected_params:
            forms.alert("Please select at least one parameter to export.", warn=True)
            return

        if not self.current_elements:
            cat_tag = self._get_current_category_tag()
            forms.alert(
                "No {} found in the current model or loaded links.\n"
                "Please make sure linked models are loaded.".format(cat_tag.lower()),
                warn=True
            )
            return

        # Ensure target directory exists
        out_dir = os.path.dirname(filepath)
        if out_dir and not os.path.exists(out_dir):
            try:
                os.makedirs(out_dir)
            except Exception as ex:
                forms.alert("Cannot create destination folder:\n{}".format(ex), error=True)
                return

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
            "title_text": "Export of {}".format(self._get_current_category_tag())
        }

        self.DialogResult = True
        self.Close()

    def on_cancel_click(self, sender, args):
        self.DialogResult = False
        self.Close()

    def get_export_options(self):
        """Returns the selected export options."""
        return self.export_options
