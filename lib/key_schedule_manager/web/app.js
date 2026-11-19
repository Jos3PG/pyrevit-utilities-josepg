/* -*- coding: utf-8 -*-
 * Frontend Application for Key Schedule Manager (WebView2 + pyRevit)
 * - Sin iconos
 * - Alto de pestañas y ancho entre paneles ajustables
 * - 4 Pestañas superiores: Campos en Uso, Agrupación y Orden, Habitaciones sin Estilo, KPIs
 * - Celdas desplegables al clic + edición de texto al doble clic + selección multicelda estilo Excel
 */

(function () {
    "use strict";

    // =========================================================================
    // 1. APPLICATION STATE
    // =========================================================================
    const appState = {
        schedulesList: [],
        currentScheduleId: null,
        originalData: null,
        originalRowsById: {},
        state: null,

        // Tab 1 selection & filter
        selectedAvailFieldKey: null,
        selectedActiveFieldKey: null,
        fieldsLeftFilterInUse: false,

        // Main Key Schedule Table Filters & Modes
        selectedRowIds: new Set(),
        columnFilters: {},
        columnWidths: {},
        orphanFilterOnly: false,
        showOnlyModified: false,
        headerSortField: null,
        headerSortAsc: true,
        nextTempRowCounter: 1,

        // Tab 3: Unassigned Elements (Habitaciones sin Estilo) State
        unassigned: {
            categoryName: "Habitaciones",
            isRoomsCategory: true,
            keyParamName: "Estilo de habitación",
            activeColumns: [],         // Array de nombres de parámetro activos como columna
            availableParams: [],       // Array de { name, is_readonly, storage_type }
            readonlyParams: new Set(),
            originalRowsById: {},
            rows: [],                  // Array de { row_id, element_id, cells }
            columnFilters: {},
            columnWidths: {},
            sortField: null,
            sortAsc: true
        },

        // Resizer tracking & modals
        userResizedTabHeight: false,
        activeDropdown: null,
        activeColReplace: null,
        internalClipboard: null,
        lastPasteTimestamp: 0,

        // Multi-cell grid contexts ("main" y "unassigned")
        grids: {
            main: {
                id: "main",
                containerId: "tableContainer",
                statusLabelId: "lblCellSelectionStatus",
                renderedRows: [], // [{ rows: [...], isCollapsedGroup: bool }]
                visibleColumns: [], // [{ key, name, isReadonly, storageType }]
                anchor: null,
                focus: null,
                selectedCells: new Set(),
                isDragging: false,
                isFillDragging: false,
                fillSourceRect: null,
                fillTargetCoord: null,
                fillPreviewCells: new Set(),
                copiedCells: new Set(),
                editingCoord: null
            },
            unassigned: {
                id: "unassigned",
                containerId: "unassignedTableContainer",
                statusLabelId: "lblUnassignedCellSel",
                renderedRows: [],
                visibleColumns: [],
                anchor: null,
                focus: null,
                selectedCells: new Set(),
                isDragging: false,
                isFillDragging: false,
                fillSourceRect: null,
                fillTargetCoord: null,
                fillPreviewCells: new Set(),
                copiedCells: new Set(),
                editingCoord: null
            }
        }
    };

    // =========================================================================
    // 2. WEBVIEW2 BRIDGE COMMUNICATION
    // =========================================================================
    function postToRevit(action, payload) {
        const message = {
            action: action,
            payload: payload || {}
        };
        if (window.chrome && window.chrome.webview) {
            window.chrome.webview.postMessage(message);
        } else {
            handleMockBridgeAction(action, payload);
        }
    }

    function setupBridgeListener() {
        if (window.chrome && window.chrome.webview) {
            window.chrome.webview.addEventListener("message", function (event) {
                let msg = event.data;
                if (typeof msg === "string") {
                    try {
                        msg = JSON.parse(msg);
                    } catch (err) {
                        console.error("Invalid JSON from Python bridge:", err);
                        return;
                    }
                }
                handleIncomingMessage(msg);
            });
            postToRevit("bridge_ready", {});
        } else {
            loadMockDemoData();
        }
    }

    function handleIncomingMessage(msg) {
        if (!msg || !msg.action) return;
        const payload = msg.payload || {};

        switch (msg.action) {
            case "init_data":
                appState.schedulesList = payload.schedules || [];
                appState.currentScheduleId = payload.selected_schedule_id;
                renderScheduleSelector();
                break;

            case "schedule_loaded":
                loadScheduleIntoState(payload);
                break;

            case "changes_applied":
                if (payload.schedules) {
                    appState.schedulesList = payload.schedules;
                    renderScheduleSelector();
                }
                if (payload.schedule_details) {
                    loadScheduleIntoState(payload.schedule_details);
                }
                const st = payload.stats || {};
                showToast(
                    "Cambios aplicados en Revit: " +
                    (st.inserted || 0) + " insertadas, " +
                    (st.updated || 0) + " claves editadas, " +
                    (st.deleted || 0) + " eliminadas, " +
                    (st.elements_updated || 0) + " elementos actualizados.",
                    "success"
                );
                break;

            case "toast":
                showToast(payload.message || "Operación completada", payload.type || "info");
                break;
        }
    }

    // =========================================================================
    // 3. STATE MANAGEMENT & DIFF ENGINE
    // =========================================================================
    function deepClone(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    function loadScheduleIntoState(details) {
        const isDifferentSchedule = appState.currentScheduleId !== details.schedule_id;
        appState.currentScheduleId = details.schedule_id;
        appState.originalData = deepClone(details);
        appState.state = deepClone(details);

        if (isDifferentSchedule) {
            appState.columnWidths = {};
            appState.unassigned.columnWidths = {};
            appState.fieldsLeftFilterInUse = false;
        }

        appState.originalRowsById = {};
        (appState.originalData.rows || []).forEach(function (r) {
            appState.originalRowsById[r.row_id] = deepClone(r);
        });

        appState.selectedRowIds.clear();
        appState.columnFilters = {};
        appState.orphanFilterOnly = false;
        appState.showOnlyModified = false;
        appState.headerSortField = null;
        clearGridSelection("main");
        document.getElementById("chkShowOnlyModified").checked = false;

        appState.selectedAvailFieldKey = appState.state.available_fields.length > 0
            ? appState.state.available_fields[0].key
            : null;
        appState.selectedActiveFieldKey = appState.state.active_fields.length > 0
            ? appState.state.active_fields[0].key
            : null;

        // Cargar datos de Habitaciones / Elementos sin Estilo asignado
        const uData = details.unassigned_data || {};
        appState.unassigned.categoryName = uData.category_name || details.category_name || "Elementos";
        appState.unassigned.isRoomsCategory = Boolean(uData.is_rooms_category);
        appState.unassigned.keyParamName = uData.key_param_name || details.key_param_name || "Estilo";
        appState.unassigned.availableParams = deepClone(uData.available_params || []);
        appState.unassigned.readonlyParams = new Set(uData.readonly_params || ["ID"]);
        appState.unassigned.activeColumns = deepClone(uData.default_columns || ["ID", appState.unassigned.keyParamName]);
        appState.unassigned.rows = deepClone(uData.rows || []);
        appState.unassigned.columnFilters = {};
        appState.unassigned.sortField = null;
        appState.unassigned.originalRowsById = {};
        appState.unassigned.rows.forEach(function (r) {
            appState.unassigned.originalRowsById[r.row_id] = deepClone(r);
        });
        clearGridSelection("unassigned");

        updateHeaderMetadata();
        populateFieldFilterDropdowns();
        populateUnassignedFilterDropdowns();
        renderAllTabs();
        renderTableAll();
        renderUnassignedTabAll();
        updateKPIsAndCommitButtons();
    }

    function isCellModified(row, fieldKey) {
        if (row.is_new) return false;
        const origRow = appState.originalRowsById[row.row_id];
        if (!origRow) return false;
        return String(origRow.cells[fieldKey] || "") !== String(row.cells[fieldKey] || "");
    }

    function getRowModifiedKeys(row) {
        if (row.is_new || !appState.state) return [];
        const origRow = appState.originalRowsById[row.row_id];
        if (!origRow) return [];
        const modKeys = [];
        const allFields = appState.state.active_fields.concat(appState.state.available_fields);
        allFields.forEach(function (f) {
            const k = f.key;
            if (String(origRow.cells[k] || "") !== String(row.cells[k] || "")) {
                modKeys.push(k);
            }
        });
        return modKeys;
    }

    function isRowModified(row) {
        if (row.is_new || row.is_deleted) return false;
        return getRowModifiedKeys(row).length > 0;
    }

    function isDefinitionModified() {
        if (!appState.originalData || !appState.state) return false;
        const o = appState.originalData;
        const s = appState.state;

        if (Boolean(o.is_itemized) !== Boolean(s.is_itemized)) return true;
        if (JSON.stringify(o.active_fields) !== JSON.stringify(s.active_fields)) return true;
        if (JSON.stringify(o.sort_group) !== JSON.stringify(s.sort_group)) return true;
        return false;
    }

    function isUnassignedCellModified(row, paramName) {
        const origRow = appState.unassigned.originalRowsById[row.row_id];
        if (!origRow) return false;
        return String(origRow.cells[paramName] || "") !== String(row.cells[paramName] || "");
    }

    function getUnassignedRowModifiedParams(row) {
        const origRow = appState.unassigned.originalRowsById[row.row_id];
        if (!origRow) return {};
        const mod = {};
        Object.keys(row.cells).forEach(function (pName) {
            if (String(origRow.cells[pName] || "") !== String(row.cells[pName] || "")) {
                mod[pName] = row.cells[pName];
            }
        });
        return mod;
    }

    function computeDiffStats() {
        if (!appState.state) {
            return {
                newRows: 0, modRows: 0, modCells: 0, delRows: 0,
                unassignedModRows: 0, unassignedModCells: 0,
                defChanged: false, hasAnyChange: false
            };
        }
        let newRows = 0;
        let modRows = 0;
        let modCells = 0;
        let delRows = 0;

        appState.state.rows.forEach(function (r) {
            if (r.is_new && !r.is_deleted) {
                newRows++;
            } else if (!r.is_new && r.is_deleted) {
                delRows++;
            } else if (!r.is_new && !r.is_deleted) {
                const mKeys = getRowModifiedKeys(r);
                if (mKeys.length > 0) {
                    modRows++;
                    modCells += mKeys.length;
                }
            }
        });

        let unassignedModRows = 0;
        let unassignedModCells = 0;
        appState.unassigned.rows.forEach(function (r) {
            const modMap = getUnassignedRowModifiedParams(r);
            const keys = Object.keys(modMap);
            if (keys.length > 0) {
                unassignedModRows++;
                unassignedModCells += keys.length;
            }
        });

        const defChanged = isDefinitionModified();
        const hasAnyChange = (newRows + modRows + delRows + unassignedModRows > 0) || defChanged;

        return {
            newRows: newRows,
            modRows: modRows,
            modCells: modCells,
            delRows: delRows,
            unassignedModRows: unassignedModRows,
            unassignedModCells: unassignedModCells,
            defChanged: defChanged,
            hasAnyChange: hasAnyChange
        };
    }

    // =========================================================================
    // 4. HEADER & KPI TAB RENDERING
    // =========================================================================
    function renderScheduleSelector() {
        const sel = document.getElementById("selSchedule");
        sel.innerHTML = "";

        if (!appState.schedulesList || appState.schedulesList.length === 0) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "No se encontraron Key Schedules en el documento";
            sel.appendChild(opt);
            return;
        }

        appState.schedulesList.forEach(function (item) {
            const opt = document.createElement("option");
            opt.value = String(item.id);
            opt.textContent = "[" + item.category_name + "] " + item.name + " (" + item.row_count + " claves)";
            if (String(item.id) === String(appState.currentScheduleId)) {
                opt.selected = true;
            }
            sel.appendChild(opt);
        });
    }

    function updateHeaderMetadata() {
        if (!appState.state) return;
        const s = appState.state;
        document.getElementById("lblCategoryBadge").textContent =
            "Categoría: " + s.category_name + "  |  Parámetro Clave: " + s.key_param_name;

        const tabTitle = appState.unassigned.isRoomsCategory
            ? "Habitaciones sin Estilo"
            : (s.category_name + " sin Clave");
        document.getElementById("lblTabUnassignedTitle").textContent = tabTitle;
    }

    function updateKPIsAndCommitButtons() {
        if (!appState.state) return;
        const s = appState.state;
        const diff = computeDiffStats();

        const activeRows = s.rows.filter(function (r) { return !r.is_deleted; });
        const totalActive = activeRows.length;

        // KPI 1: Total Claves & Cambios
        document.getElementById("kpiTotalRows").textContent = String(totalActive);
        document.getElementById("kpiNewCount").textContent = diff.newRows + " nuevas";
        document.getElementById("kpiModCount").textContent =
            (diff.modCells + diff.unassignedModCells) + " celdas editadas";
        document.getElementById("kpiDelCount").textContent = diff.delRows + " eliminadas";

        const pendingBadge = document.getElementById("kpiPendingBadge");
        if (diff.hasAnyChange) {
            pendingBadge.textContent = "Cambios en vista previa";
            pendingBadge.classList.add("has-changes");
        } else {
            pendingBadge.textContent = "Sin cambios";
            pendingBadge.classList.remove("has-changes");
        }

        document.getElementById("kpiCardChanges").classList.toggle("active-filter", appState.showOnlyModified);

        // KPI 2: Uso en el Modelo
        let usedKeys = 0;
        let orphanKeys = 0;
        let totalAssignedElements = 0;

        activeRows.forEach(function (r) {
            const u = Number(r.usage_count || 0);
            if (u > 0) {
                usedKeys++;
                totalAssignedElements += u;
            } else {
                orphanKeys++;
            }
        });

        document.getElementById("kpiUsedKeys").textContent = String(usedKeys);
        document.getElementById("kpiOrphanKeys").textContent = String(orphanKeys);
        const usagePct = totalActive > 0 ? Math.round((usedKeys / totalActive) * 100) : 0;
        document.getElementById("barUsageRatio").style.width = usagePct + "%";

        document.getElementById("kpiCardOrphans").classList.toggle("active-filter", appState.orphanFilterOnly);
        document.getElementById("kpiOrphanActionTag").textContent =
            appState.orphanFilterOnly ? "Mostrando huérfanas (Quitar)" : "Filtrar huérfanas";

        // KPI 3: Completitud de datos (%)
        const visibleFields = s.active_fields.filter(function (f) { return !f.is_hidden; });
        const totalCells = totalActive * visibleFields.length;
        let filledCells = 0;
        activeRows.forEach(function (r) {
            visibleFields.forEach(function (f) {
                const val = String(r.cells[f.key] || "").trim();
                if (val !== "") filledCells++;
            });
        });
        const emptyCells = Math.max(0, totalCells - filledCells);
        const compPct = totalCells > 0 ? Math.round((filledCells / totalCells) * 100) : 100;

        document.getElementById("kpiCompletenessPct").textContent = compPct + "%";
        document.getElementById("kpiEmptyCellsCount").textContent = emptyCells + " celdas vacías";
        document.getElementById("barCompleteness").style.width = compPct + "%";

        // KPI 4: Impacto en el modelo
        document.getElementById("kpiCategoryName").textContent = s.category_name;
        document.getElementById("kpiImpactedElements").textContent = String(totalAssignedElements);
        document.getElementById("kpiTotalModelElements").textContent = String(s.total_model_elements || 0);
        document.getElementById("kpiKeyParamInfo").innerHTML =
            "Parámetro clave: <strong>" + escapeHtml(s.key_param_name) + "</strong>";

        // Indicador de estado de estructura en pestañas
        const defStatus = document.getElementById("defStatusIndicator");
        if (diff.defChanged) {
            defStatus.textContent = "Estructura modificada en vista previa (pendiente de aplicar)";
            defStatus.classList.add("modified");
        } else if (diff.unassignedModRows > 0) {
            defStatus.textContent = diff.unassignedModRows + " elemento(s) sin estilo con asignaciones pendientes";
            defStatus.classList.add("modified");
        } else {
            defStatus.textContent = "Estructura sincronizada con Revit";
            defStatus.classList.remove("modified");
        }

        // Badge de elementos sin estilo
        document.getElementById("badgeUnassignedCount").textContent = String(appState.unassigned.rows.length);

        document.getElementById("btnApplyChanges").disabled = !diff.hasAnyChange;
        document.getElementById("btnDiscardChanges").disabled = !diff.hasAnyChange;
    }

    // =========================================================================
    // 5. TOP TABS: CAMPOS EN USO, AGRUPACION Y ORDEN
    // =========================================================================
    function renderAllTabs() {
        if (!appState.state) return;
        renderTabFields();
        renderTabSorting();
        updateTabBadges();
    }

    function updateTabBadges() {
        if (!appState.state) return;
        document.getElementById("badgeFieldsCount").textContent = String(appState.state.active_fields.length);
        document.getElementById("badgeSortCount").textContent = String(appState.state.sort_group.length);
        document.getElementById("badgeUnassignedCount").textContent = String(appState.unassigned.rows.length);
    }

    function renderTabFields() {
        const s = appState.state;
        const searchAvail = (document.getElementById("txtSearchAvailFields").value || "").trim().toLowerCase();
        const showInUse = Boolean(appState.fieldsLeftFilterInUse);

        const btnToggleInUse = document.getElementById("btnToggleInUseFields");
        if (btnToggleInUse) {
            btnToggleInUse.classList.toggle("btn-toggle-active", showInUse);
        }

        const sourceList = showInUse ? s.active_fields : s.available_fields;
        const filteredLeft = sourceList.filter(function (f) {
            return !searchAvail || f.name.toLowerCase().indexOf(searchAvail) !== -1;
        });

        const lblTitle = document.getElementById("lblFieldsLeftTitle");
        if (lblTitle) {
            lblTitle.innerHTML = (showInUse ? "Campos en uso (" : "Campos disponibles (") +
                '<span id="lblAvailCount">' + filteredLeft.length + '</span>)';
        } else {
            document.getElementById("lblAvailCount").textContent = String(filteredLeft.length);
        }

        const availContainer = document.getElementById("listAvailFields");
        availContainer.innerHTML = "";

        filteredLeft.forEach(function (f) {
            const div = document.createElement("div");
            const isSel = showInUse
                ? (appState.selectedActiveFieldKey === f.key)
                : (appState.selectedAvailFieldKey === f.key);
            div.className = "field-item" + (isSel ? " selected" : "");

            const spanName = document.createElement("span");
            spanName.textContent = f.name;
            div.appendChild(spanName);

            if (showInUse) {
                const tag = document.createElement("span");
                tag.className = "field-inuse-tag";
                tag.textContent = f.is_key_name ? "Clave" : "En uso";
                div.appendChild(tag);
            }

            div.addEventListener("click", function () {
                if (showInUse) {
                    appState.selectedActiveFieldKey = f.key;
                } else {
                    appState.selectedAvailFieldKey = f.key;
                }
                renderTabFields();
            });
            div.addEventListener("dblclick", function () {
                if (showInUse) {
                    appState.selectedActiveFieldKey = f.key;
                    removeSelectedFieldFromSchedule();
                } else {
                    appState.selectedAvailFieldKey = f.key;
                    addSelectedFieldToSchedule();
                }
            });
            availContainer.appendChild(div);
        });

        const activeContainer = document.getElementById("listActiveFields");
        activeContainer.innerHTML = "";

        s.active_fields.forEach(function (f, idx) {
            const row = document.createElement("div");
            row.className = "field-item" + (appState.selectedActiveFieldKey === f.key ? " selected" : "");
            row.addEventListener("click", function () {
                appState.selectedActiveFieldKey = f.key;
                renderTabFields();
            });

            const left = document.createElement("div");
            left.className = "field-item-left";
            left.innerHTML =
                '<span class="field-order-num">' + (idx + 1) + '.</span>' +
                '<span>' + escapeHtml(f.name) + (f.is_key_name ? ' <strong>[Clave]</strong>' : '') + '</span>';

            const right = document.createElement("div");
            right.className = "field-item-controls";

            const headingInput = document.createElement("input");
            headingInput.type = "text";
            headingInput.className = "heading-input";
            headingInput.value = f.heading || f.name;
            headingInput.title = "Encabezado de columna en la tabla";
            headingInput.addEventListener("click", function (ev) { ev.stopPropagation(); });
            headingInput.addEventListener("input", function (ev) {
                f.heading = ev.target.value;
                renderTableHead();
                updateKPIsAndCommitButtons();
            });

            const hiddenLabel = document.createElement("label");
            hiddenLabel.className = "checkbox-label";
            hiddenLabel.title = "Ocultar columna en la vista de Revit";
            hiddenLabel.addEventListener("click", function (ev) { ev.stopPropagation(); });

            const chkHidden = document.createElement("input");
            chkHidden.type = "checkbox";
            chkHidden.checked = Boolean(f.is_hidden);
            chkHidden.addEventListener("change", function (ev) {
                f.is_hidden = ev.target.checked;
                renderTableAll();
                updateKPIsAndCommitButtons();
            });
            hiddenLabel.appendChild(chkHidden);
            hiddenLabel.appendChild(document.createTextNode("Ocultar"));

            right.appendChild(headingInput);
            right.appendChild(hiddenLabel);

            row.appendChild(left);
            row.appendChild(right);
            activeContainer.appendChild(row);
        });
    }

    function addSelectedFieldToSchedule() {
        const s = appState.state;
        if (!s || !appState.selectedAvailFieldKey) return;
        const idx = s.available_fields.findIndex(function (f) { return f.key === appState.selectedAvailFieldKey; });
        if (idx === -1) return;

        const fieldObj = s.available_fields.splice(idx, 1)[0];
        s.active_fields.push(fieldObj);

        s.rows.forEach(function (r) {
            if (!(fieldObj.key in r.cells)) {
                r.cells[fieldObj.key] = "";
            }
        });

        appState.selectedActiveFieldKey = fieldObj.key;
        appState.selectedAvailFieldKey = s.available_fields[0] ? s.available_fields[0].key : null;

        populateFieldFilterDropdowns();
        renderAllTabs();
        renderTableAll();
        updateKPIsAndCommitButtons();
    }

    function removeSelectedFieldFromSchedule() {
        const s = appState.state;
        if (!s || !appState.selectedActiveFieldKey) return;
        const idx = s.active_fields.findIndex(function (f) { return f.key === appState.selectedActiveFieldKey; });
        if (idx === -1) return;

        const fieldObj = s.active_fields[idx];
        if (fieldObj.is_key_name) {
            showToast("El campo clave (Key Name) es obligatorio en una Key Schedule y no puede quitarse.", "error");
            return;
        }

        s.active_fields.splice(idx, 1);
        s.available_fields.push(fieldObj);
        s.available_fields.sort(function (a, b) { return a.name.localeCompare(b.name); });

        s.sort_group = s.sort_group.filter(function (sg) { return sg.field_key !== fieldObj.key; });

        appState.selectedActiveFieldKey = s.active_fields[Math.min(idx, s.active_fields.length - 1)]
            ? s.active_fields[Math.min(idx, s.active_fields.length - 1)].key
            : null;
        appState.selectedAvailFieldKey = fieldObj.key;

        populateFieldFilterDropdowns();
        renderAllTabs();
        renderTableAll();
        updateKPIsAndCommitButtons();
    }

    function moveSelectedActiveField(direction) {
        const s = appState.state;
        if (!s || !appState.selectedActiveFieldKey) return;
        const idx = s.active_fields.findIndex(function (f) { return f.key === appState.selectedActiveFieldKey; });
        if (idx === -1) return;
        const targetIdx = idx + direction;
        if (targetIdx < 0 || targetIdx >= s.active_fields.length) return;

        const temp = s.active_fields[idx];
        s.active_fields[idx] = s.active_fields[targetIdx];
        s.active_fields[targetIdx] = temp;

        populateFieldFilterDropdowns();
        renderTabFields();
        renderTableAll();
        updateKPIsAndCommitButtons();
    }

    function renderTabSorting() {
        const s = appState.state;
        document.getElementById("chkItemizeEveryInstance").checked = Boolean(s.is_itemized);

        const container = document.getElementById("listSortRules");
        container.innerHTML = "";

        if (s.sort_group.length === 0) {
            const empty = document.createElement("div");
            empty.className = "hint-text";
            empty.textContent = "Sin reglas de agrupación u ordenación definidas (se ordena por Key Name por defecto).";
            container.appendChild(empty);
            return;
        }

        s.sort_group.forEach(function (sg, idx) {
            const row = document.createElement("div");
            row.className = "rule-row";

            const lbl = document.createElement("span");
            lbl.className = "rule-index";
            lbl.textContent = (idx === 0 ? "Agrupar por:" : "Luego por:");

            const selField = document.createElement("select");
            selField.className = "input-control select-sm";
            s.active_fields.forEach(function (f) {
                const opt = document.createElement("option");
                opt.value = f.key;
                opt.textContent = f.heading || f.name;
                if (f.key === sg.field_key) opt.selected = true;
                selField.appendChild(opt);
            });
            selField.addEventListener("change", function (ev) {
                sg.field_key = ev.target.value;
                appState.headerSortField = null;
                renderTableHead();
                renderTableBody();
                updateKPIsAndCommitButtons();
            });

            const selOrder = document.createElement("select");
            selOrder.className = "input-control select-xs";
            [
                { value: "Ascending", label: "Ascendente (A-Z)" },
                { value: "Descending", label: "Descendente (Z-A)" }
            ].forEach(function (o) {
                const opt = document.createElement("option");
                opt.value = o.value;
                opt.textContent = o.label;
                if (o.value === sg.sort_order) opt.selected = true;
                selOrder.appendChild(opt);
            });
            selOrder.addEventListener("change", function (ev) {
                sg.sort_order = ev.target.value;
                appState.headerSortField = null;
                renderTableHead();
                renderTableBody();
                updateKPIsAndCommitButtons();
            });

            const mkCheck = function (prop, labelText) {
                const lb = document.createElement("label");
                lb.className = "checkbox-label";
                const ck = document.createElement("input");
                ck.type = "checkbox";
                ck.checked = Boolean(sg[prop]);
                ck.addEventListener("change", function (ev) {
                    sg[prop] = ev.target.checked;
                    renderTableBody();
                    updateKPIsAndCommitButtons();
                });
                lb.appendChild(ck);
                lb.appendChild(document.createTextNode(labelText));
                return lb;
            };

            const btnDel = document.createElement("button");
            btnDel.className = "btn btn-danger btn-sm";
            btnDel.textContent = "Quitar";
            btnDel.addEventListener("click", function () {
                s.sort_group.splice(idx, 1);
                appState.headerSortField = null;
                renderTabSorting();
                updateTabBadges();
                renderTableHead();
                renderTableBody();
                updateKPIsAndCommitButtons();
            });

            row.appendChild(lbl);
            row.appendChild(selField);
            row.appendChild(selOrder);
            row.appendChild(mkCheck("show_header", "Encabezado"));
            row.appendChild(mkCheck("show_footer", "Pie de grupo"));
            row.appendChild(mkCheck("show_blank_line", "Línea en blanco"));
            row.appendChild(btnDel);
            container.appendChild(row);
        });
    }

    // =========================================================================
    // 6. SHARED EXCEL-LIKE MULTI-CELL SELECTION, DROPDOWN & DOUBLE-CLICK EDIT
    // =========================================================================
    function cellCoordKey(r, c) {
        return r + ":" + c;
    }

    function clearGridSelection(gridId) {
        const ctx = appState.grids[gridId];
        if (!ctx) return;
        ctx.anchor = null;
        ctx.focus = null;
        ctx.selectedCells.clear();
        ctx.isDragging = false;
        ctx.isFillDragging = false;
        ctx.fillSourceRect = null;
        ctx.fillTargetCoord = null;
        ctx.fillPreviewCells.clear();
        ctx.copiedCells.clear();
        ctx.editingCoord = null;
        updateGridSelectionDOM(gridId);
    }

    function getSelectionBounds(ctx) {
        if (!ctx || ctx.selectedCells.size === 0) return null;
        let rMin = Infinity, rMax = -Infinity, cMin = Infinity, cMax = -Infinity;
        ctx.selectedCells.forEach(function (coordStr) {
            const parts = coordStr.split(":");
            const r = parseInt(parts[0], 10);
            const c = parseInt(parts[1], 10);
            if (r < rMin) rMin = r;
            if (r > rMax) rMax = r;
            if (c < cMin) cMin = c;
            if (c > cMax) cMax = c;
        });
        if (rMin === Infinity) return null;
        return { rMin: rMin, rMax: rMax, cMin: cMin, cMax: cMax };
    }

    function computeRectSelectionSet(anchor, focus) {
        const set = new Set();
        if (!anchor || !focus) return set;
        const rMin = Math.min(anchor.r, focus.r);
        const rMax = Math.max(anchor.r, focus.r);
        const cMin = Math.min(anchor.c, focus.c);
        const cMax = Math.max(anchor.c, focus.c);
        for (let r = rMin; r <= rMax; r++) {
            for (let c = cMin; c <= cMax; c++) {
                set.add(cellCoordKey(r, c));
            }
        }
        return set;
    }

    function updateGridSelectionDOM(gridId) {
        const ctx = appState.grids[gridId];
        const container = document.getElementById(ctx.containerId);
        if (!container) return;

        // Limpiar handles de relleno anteriores
        container.querySelectorAll(".excel-fill-handle").forEach(function (h) {
            if (h.parentNode) h.parentNode.removeChild(h);
        });

        const tdNodes = container.querySelectorAll(".ks-td-data");
        const anchorKey = ctx.anchor ? cellCoordKey(ctx.anchor.r, ctx.anchor.c) : null;
        const bounds = getSelectionBounds(ctx);
        const handleCoordKey = bounds ? cellCoordKey(bounds.rMax, bounds.cMax) : null;

        tdNodes.forEach(function (td) {
            const key = td.getAttribute("data-cell-coord");
            const isSel = ctx.selectedCells.has(key);
            const isAnc = (key === anchorKey);
            const isFillPrev = ctx.fillPreviewCells.has(key);
            const isCopied = ctx.copiedCells.has(key);

            td.classList.toggle("cell-range-selected", isSel);
            td.classList.toggle("cell-range-anchor", isAnc);
            td.classList.toggle("cell-fill-preview", isFillPrev);
            td.classList.toggle("cell-copied", isCopied);

            if (key === handleCoordKey && !ctx.editingCoord && !td.classList.contains("cell-readonly")) {
                const handle = document.createElement("div");
                handle.className = "excel-fill-handle";
                handle.title = "Arrastra hacia abajo o los lados para autorrellenar como en Excel";
                handle.addEventListener("mousedown", function (ev) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    ctx.isFillDragging = true;
                    ctx.isDragging = false;
                    ctx.fillSourceRect = bounds;
                    ctx.fillTargetCoord = { r: bounds.rMax, c: bounds.cMax };
                    ctx.fillPreviewCells.clear();
                });
                td.appendChild(handle);
            }
        });

        const count = ctx.selectedCells.size;
        const lbl = document.getElementById(ctx.statusLabelId);
        if (lbl) {
            if (gridId === "unassigned") {
                lbl.textContent = count + (count === 1 ? " celda" : " celdas");
            } else {
                lbl.textContent = count + (count === 1 ? " celda seleccionada" : " celdas seleccionadas");
            }
        }
    }

    function writeTextToSystemClipboard(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(function () {
                fallbackExecCommandCopy(text);
            });
        } else {
            fallbackExecCommandCopy(text);
        }
    }

    function fallbackExecCommandCopy(text) {
        try {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.left = "-9999px";
            ta.style.top = "-9999px";
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
        } catch (e) {}
    }

    function copySelectedCellsToClipboard(gridId) {
        const ctx = appState.grids[gridId];
        const bounds = getSelectionBounds(ctx);
        if (!bounds) return;

        const lines = [];
        for (let r = bounds.rMin; r <= bounds.rMax; r++) {
            const rowBundle = ctx.renderedRows[r];
            const rowVals = [];
            for (let c = bounds.cMin; c <= bounds.cMax; c++) {
                const colMeta = ctx.visibleColumns[c];
                if (!rowBundle || !colMeta) {
                    rowVals.push("");
                } else {
                    rowVals.push(String(rowBundle.rows[0].cells[colMeta.key] || ""));
                }
            }
            lines.push(rowVals.join("\t"));
        }

        const tsv = lines.join("\n");
        const rowCount = bounds.rMax - bounds.rMin + 1;
        const colCount = bounds.cMax - bounds.cMin + 1;
        appState.internalClipboard = {
            tsv: tsv,
            rowCount: rowCount,
            colCount: colCount
        };
        ctx.copiedCells = new Set(ctx.selectedCells);
        updateGridSelectionDOM(gridId);
        writeTextToSystemClipboard(tsv);
        showToast(
            "Copiadas " + ctx.selectedCells.size + " celda(s) (" + rowCount + "x" + colCount + "). Selecciona el destino y pulsa Ctrl+V.",
            "info"
        );
    }

    function handleGridPasteText(gridId, rawText) {
        if (!rawText) return;
        const ctx = appState.grids[gridId];
        if (!ctx.anchor) return;

        const normalized = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const isSingleValue = (normalized.indexOf("\t") === -1 && normalized.indexOf("\n") === -1);

        if (isSingleValue && ctx.selectedCells.size > 1) {
            applyValueToGridSelection(gridId, normalized.trim(), cellCoordKey(ctx.anchor.r, ctx.anchor.c));
            showToast("Pegado valor en " + ctx.selectedCells.size + " celdas seleccionadas.", "success");
            return;
        }

        applyDirectGridPaste(gridId, rawText, ctx.anchor.r, ctx.anchor.c);
    }

    function computeFillExtensionDirection(srcRect, targetCoord) {
        if (!srcRect || !targetCoord) return null;
        const drDown = Math.max(0, targetCoord.r - srcRect.rMax);
        const drUp = Math.max(0, srcRect.rMin - targetCoord.r);
        const dcRight = Math.max(0, targetCoord.c - srcRect.cMax);
        const dcLeft = Math.max(0, srcRect.cMin - targetCoord.c);

        const maxV = Math.max(drDown, drUp);
        const maxH = Math.max(dcRight, dcLeft);
        if (maxV === 0 && maxH === 0) return null;

        if (maxV >= maxH) {
            return drDown >= drUp
                ? { axis: "vertical", dir: 1, limit: targetCoord.r }
                : { axis: "vertical", dir: -1, limit: targetCoord.r };
        }
        return dcRight >= dcLeft
            ? { axis: "horizontal", dir: 1, limit: targetCoord.c }
            : { axis: "horizontal", dir: -1, limit: targetCoord.c };
    }

    function updateFillPreviewForCoord(gridId, hoverCoord) {
        const ctx = appState.grids[gridId];
        if (!ctx.isFillDragging || !ctx.fillSourceRect) return;
        ctx.fillTargetCoord = hoverCoord;
        ctx.fillPreviewCells.clear();

        const ext = computeFillExtensionDirection(ctx.fillSourceRect, hoverCoord);
        if (ext) {
            const s = ctx.fillSourceRect;
            if (ext.axis === "vertical") {
                const rStart = ext.dir > 0 ? s.rMax + 1 : ext.limit;
                const rEnd = ext.dir > 0 ? ext.limit : s.rMin - 1;
                for (let r = rStart; r <= rEnd; r++) {
                    for (let c = s.cMin; c <= s.cMax; c++) {
                        ctx.fillPreviewCells.add(cellCoordKey(r, c));
                    }
                }
            } else {
                const cStart = ext.dir > 0 ? s.cMax + 1 : ext.limit;
                const cEnd = ext.dir > 0 ? ext.limit : s.cMin - 1;
                for (let r = s.rMin; r <= s.rMax; r++) {
                    for (let c = cStart; c <= cEnd; c++) {
                        ctx.fillPreviewCells.add(cellCoordKey(r, c));
                    }
                }
            }
        }
        updateGridSelectionDOM(gridId);
    }

    function generateSmartFillValue(sourceVals, stepOffset, forwardIndex) {
        if (!sourceVals || sourceVals.length === 0) return "";
        if (sourceVals.length === 1) return sourceVals[0];

        // 1. Verificar si todos los elementos origen son números puros
        const numRegex = /^-?\d+(?:[.,]\d+)?$/;
        const allNumeric = sourceVals.every(function (v) { return numRegex.test(v.trim()); });
        if (allNumeric) {
            const usesComma = sourceVals.some(function (v) { return v.indexOf(",") !== -1; });
            const nums = sourceVals.map(function (v) { return parseFloat(v.trim().replace(",", ".")); });
            const step = nums[1] - nums[0];
            let isArith = true;
            for (let i = 2; i < nums.length; i++) {
                if (Math.abs((nums[i] - nums[i - 1]) - step) > 1e-6) {
                    isArith = false;
                    break;
                }
            }
            if (isArith) {
                const base = stepOffset > 0 ? nums[nums.length - 1] : nums[0];
                const rawRes = base + step * stepOffset;
                const rounded = Math.round(rawRes * 1000000) / 1000000;
                const outStr = String(rounded);
                return usesComma ? outStr.replace(".", ",") : outStr;
            }
        }

        // 2. Verificar patrón texto + número (ej. "AC-01", "AC-02" o "Puerta 1", "Puerta 2")
        const tokenRegex = /^(.*?)(\d+)([^\d]*)$/;
        const parsedTokens = sourceVals.map(function (v) { return tokenRegex.exec(v); });
        if (parsedTokens.every(function (m) { return m !== null; })) {
            const pref0 = parsedTokens[0][1];
            const suf0 = parsedTokens[0][3];
            const sameAffix = parsedTokens.every(function (m) { return m[1] === pref0 && m[3] === suf0; });
            if (sameAffix) {
                const tNums = parsedTokens.map(function (m) { return parseInt(m[2], 10); });
                const tStep = tNums[1] - tNums[0];
                let isTokenArith = true;
                for (let i = 2; i < tNums.length; i++) {
                    if ((tNums[i] - tNums[i - 1]) !== tStep) {
                        isTokenArith = false;
                        break;
                    }
                }
                if (isTokenArith) {
                    const baseNum = stepOffset > 0 ? tNums[tNums.length - 1] : tNums[0];
                    const nextNum = baseNum + tStep * stepOffset;
                    if (nextNum >= 0) {
                        const hasLeadingZero = parsedTokens.some(function (m) {
                            return m[2].length > 1 && m[2][0] === "0";
                        });
                        const padLen = hasLeadingZero ? parsedTokens[0][2].length : 0;
                        let numStr = String(nextNum);
                        while (numStr.length < padLen) numStr = "0" + numStr;
                        return pref0 + numStr + suf0;
                    }
                }
            }
        }

        // 3. Fallback: repetición cíclica de los valores seleccionados
        const len = sourceVals.length;
        const idx = ((forwardIndex % len) + len) % len;
        return sourceVals[idx];
    }

    function executeExcelFillDrag(gridId) {
        const ctx = appState.grids[gridId];
        if (!ctx.isFillDragging) return;

        const src = ctx.fillSourceRect;
        const target = ctx.fillTargetCoord;
        ctx.isFillDragging = false;
        ctx.fillSourceRect = null;
        ctx.fillTargetCoord = null;
        ctx.fillPreviewCells.clear();

        if (!src || !target) {
            updateGridSelectionDOM(gridId);
            return;
        }

        const ext = computeFillExtensionDirection(src, target);
        if (!ext) {
            updateGridSelectionDOM(gridId);
            return;
        }

        let filledCount = 0;

        if (ext.axis === "vertical") {
            const countSteps = ext.dir > 0 ? (ext.limit - src.rMax) : (src.rMin - ext.limit);
            for (let c = src.cMin; c <= src.cMax; c++) {
                const colMeta = ctx.visibleColumns[c];
                if (!colMeta || colMeta.isReadonly) continue;

                const sourceVals = [];
                for (let r = src.rMin; r <= src.rMax; r++) {
                    const rb = ctx.renderedRows[r];
                    sourceVals.push(rb ? String(rb.rows[0].cells[colMeta.key] || "") : "");
                }

                for (let s = 1; s <= countSteps; s++) {
                    const targetRowIdx = ext.dir > 0 ? (src.rMax + s) : (src.rMin - s);
                    const stepOffset = ext.dir > 0 ? s : -s;
                    const forwardIdx = ext.dir > 0 ? (s - 1) : (sourceVals.length - (s % sourceVals.length));
                    const newVal = generateSmartFillValue(sourceVals, stepOffset, forwardIdx);

                    const targetBundle = ctx.renderedRows[targetRowIdx];
                    if (targetBundle) {
                        targetBundle.rows.forEach(function (rObj) {
                            if (!rObj.is_deleted) {
                                rObj.cells[colMeta.key] = newVal;
                                filledCount++;
                            }
                        });
                    }
                }
            }
            const newRMin = ext.dir > 0 ? src.rMin : ext.limit;
            const newRMax = ext.dir > 0 ? ext.limit : src.rMax;
            ctx.anchor = { r: newRMin, c: src.cMin };
            ctx.focus = { r: newRMax, c: src.cMax };
            ctx.selectedCells = computeRectSelectionSet(ctx.anchor, ctx.focus);
        } else {
            const countSteps = ext.dir > 0 ? (ext.limit - src.cMax) : (src.cMin - ext.limit);
            for (let r = src.rMin; r <= src.rMax; r++) {
                const rowBundle = ctx.renderedRows[r];
                if (!rowBundle) continue;

                const sourceVals = [];
                for (let c = src.cMin; c <= src.cMax; c++) {
                    const cm = ctx.visibleColumns[c];
                    sourceVals.push(cm ? String(rowBundle.rows[0].cells[cm.key] || "") : "");
                }

                for (let s = 1; s <= countSteps; s++) {
                    const targetColIdx = ext.dir > 0 ? (src.cMax + s) : (src.cMin - s);
                    const targetColMeta = ctx.visibleColumns[targetColIdx];
                    if (!targetColMeta || targetColMeta.isReadonly) continue;

                    const stepOffset = ext.dir > 0 ? s : -s;
                    const forwardIdx = ext.dir > 0 ? (s - 1) : (sourceVals.length - (s % sourceVals.length));
                    const newVal = generateSmartFillValue(sourceVals, stepOffset, forwardIdx);

                    rowBundle.rows.forEach(function (rObj) {
                        if (!rObj.is_deleted) {
                            rObj.cells[targetColMeta.key] = newVal;
                            filledCount++;
                        }
                    });
                }
            }
            const newCMin = ext.dir > 0 ? src.cMin : ext.limit;
            const newCMax = ext.dir > 0 ? ext.limit : src.cMax;
            ctx.anchor = { r: src.rMin, c: newCMin };
            ctx.focus = { r: src.rMax, c: newCMax };
            ctx.selectedCells = computeRectSelectionSet(ctx.anchor, ctx.focus);
        }

        if (filledCount > 0) {
            if (gridId === "main") {
                renderTableBody();
                renderUnassignedTableBody();
            } else {
                renderUnassignedTableBody();
            }
            updateKPIsAndCommitButtons();
            showToast("Autorrelleno aplicado en " + filledCount + " celda(s).", "success");
        } else {
            updateGridSelectionDOM(gridId);
        }
    }

    function applyValueToGridSelection(gridId, newValue, fallbackCoordKey) {
        const ctx = appState.grids[gridId];
        const coordsToApply = ctx.selectedCells.size > 0
            ? Array.from(ctx.selectedCells)
            : (fallbackCoordKey ? [fallbackCoordKey] : []);

        let changed = 0;
        coordsToApply.forEach(function (coordStr) {
            const parts = coordStr.split(":");
            const rIdx = parseInt(parts[0], 10);
            const cIdx = parseInt(parts[1], 10);
            const rowBundle = ctx.renderedRows[rIdx];
            const colMeta = ctx.visibleColumns[cIdx];
            if (!rowBundle || !colMeta || colMeta.isReadonly) return;

            rowBundle.rows.forEach(function (rowObj) {
                if (!rowObj.is_deleted) {
                    rowObj.cells[colMeta.key] = newValue;
                    changed++;
                }
            });
        });

        if (changed > 0) {
            if (gridId === "main") {
                renderTableBody();
                // Si se editó un Key Name, actualizar también los desplegables de la pestaña habitaciones
                renderUnassignedTableBody();
            } else {
                renderUnassignedTableBody();
            }
            updateKPIsAndCommitButtons();
        }
    }

    function getDropdownOptionsForCell(gridId, colMeta) {
        if (colMeta.storageType === "Boolean") {
            return ["Yes", "No", ""];
        }

        if (gridId === "unassigned") {
            // Si es la columna del parámetro clave (Estilo de habitación), listar todas las claves activas de la Key Schedule
            if (colMeta.key === appState.unassigned.keyParamName && appState.state) {
                const keyField = appState.state.active_fields[0] ? appState.state.active_fields[0].key : null;
                const keysSet = new Set();
                if (keyField) {
                    appState.state.rows.forEach(function (r) {
                        if (!r.is_deleted) {
                            const val = String(r.cells[keyField] || "").trim();
                            if (val !== "") keysSet.add(val);
                        }
                    });
                }
                const list = Array.from(keysSet).sort(function (a, b) {
                    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
                });
                list.unshift(""); // Opción "(Sin asignar)"
                return list;
            }

            // Para otros parámetros de habitaciones, valores únicos existentes en la columna
            const uniq = new Set();
            appState.unassigned.rows.forEach(function (r) {
                const v = String(r.cells[colMeta.key] || "").trim();
                if (v !== "") uniq.add(v);
            });
            const arr = Array.from(uniq).sort(function (a, b) {
                return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
            });
            arr.push("");
            return arr;
        }

        // Grid principal (Key Schedule): valores únicos en esa columna
        const uniqMain = new Set();
        if (appState.state) {
            appState.state.rows.forEach(function (r) {
                if (!r.is_deleted) {
                    const v = String(r.cells[colMeta.key] || "").trim();
                    if (v !== "") uniqMain.add(v);
                }
            });
        }
        const arrMain = Array.from(uniqMain).sort(function (a, b) {
            return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
        });
        arrMain.push("");
        return arrMain;
    }

    function closeCellDropdown() {
        const menu = document.getElementById("cellDropdownMenu");
        menu.classList.add("hidden");
        appState.activeDropdown = null;
    }

    function openCellDropdown(gridId, tdEl, rIdx, cIdx) {
        const ctx = appState.grids[gridId];
        const colMeta = ctx.visibleColumns[cIdx];
        const rowBundle = ctx.renderedRows[rIdx];
        if (!colMeta || !rowBundle || colMeta.isReadonly) return;
        if (rowBundle.rows.every(function (r) { return r.is_deleted; })) return;

        const cKey = cellCoordKey(rIdx, cIdx);
        if (!ctx.selectedCells.has(cKey)) {
            ctx.anchor = { r: rIdx, c: cIdx };
            ctx.focus = { r: rIdx, c: cIdx };
            ctx.selectedCells = new Set([cKey]);
            updateGridSelectionDOM(gridId);
        }

        const options = getDropdownOptionsForCell(gridId, colMeta);
        appState.activeDropdown = {
            gridId: gridId,
            coordKey: cKey,
            colMeta: colMeta,
            options: options
        };

        const menu = document.getElementById("cellDropdownMenu");
        const filterInp = document.getElementById("txtDropdownFilter");
        filterInp.value = "";
        renderDropdownOptionsList(options, "");

        const rect = tdEl.getBoundingClientRect();
        menu.style.minWidth = Math.max(190, rect.width) + "px";
        menu.classList.remove("hidden");

        // Posicionar debajo o arriba según el espacio en pantalla
        const menuHeight = menu.offsetHeight || 240;
        const spaceBelow = window.innerHeight - rect.bottom;
        const topPos = spaceBelow >= menuHeight + 8 ? rect.bottom + 2 : Math.max(8, rect.top - menuHeight - 2);
        const leftPos = Math.min(rect.left, window.innerWidth - (menu.offsetWidth || 240) - 10);

        menu.style.top = topPos + "px";
        menu.style.left = Math.max(8, leftPos) + "px";

        setTimeout(function () { filterInp.focus(); }, 10);
    }

    function renderDropdownOptionsList(options, query) {
        const listEl = document.getElementById("cellDropdownList");
        listEl.innerHTML = "";
        const q = (query || "").trim().toLowerCase();

        const filtered = options.filter(function (opt) {
            if (!q) return true;
            const label = opt === "" ? "(vacío / sin asignar)" : opt.toLowerCase();
            return label.indexOf(q) !== -1;
        });

        if (filtered.length === 0) {
            const empty = document.createElement("div");
            empty.className = "dropdown-option-item dropdown-option-empty";
            empty.textContent = "Sin coincidencias (doble clic en celda para escribir texto libre)";
            listEl.appendChild(empty);
            return;
        }

        const dd = appState.activeDropdown;
        filtered.forEach(function (val) {
            const item = document.createElement("div");
            item.className = "dropdown-option-item" + (val === "" ? " dropdown-option-empty" : "");
            if (val === "") {
                item.textContent = (dd && dd.gridId === "unassigned" && dd.colMeta.key === appState.unassigned.keyParamName)
                    ? "(Sin asignar)"
                    : "(Vacío)";
            } else {
                item.textContent = val;
            }
            item.addEventListener("mousedown", function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                if (!appState.activeDropdown) return;
                const targetGridId = appState.activeDropdown.gridId;
                const targetCoord = appState.activeDropdown.coordKey;
                closeCellDropdown();
                applyValueToGridSelection(targetGridId, val, targetCoord);
            });
            listEl.appendChild(item);
        });
    }

    function enterCellInlineEdit(gridId, tdEl, rIdx, cIdx, initialChar) {
        const ctx = appState.grids[gridId];
        const colMeta = ctx.visibleColumns[cIdx];
        const rowBundle = ctx.renderedRows[rIdx];
        if (!colMeta || !rowBundle || colMeta.isReadonly) return;
        if (rowBundle.rows.every(function (r) { return r.is_deleted; })) return;

        closeCellDropdown();

        const cKey = cellCoordKey(rIdx, cIdx);
        ctx.editingCoord = cKey;

        const firstRow = rowBundle.rows[0];
        const firstVal = String(firstRow.cells[colMeta.key] || "");
        let varies = false;
        if (rowBundle.isCollapsedGroup) {
            for (let i = 1; i < rowBundle.rows.length; i++) {
                if (String(rowBundle.rows[i].cells[colMeta.key] || "") !== firstVal) {
                    varies = true;
                    break;
                }
            }
        }

        const wrap = tdEl.querySelector(".cell-wrapper");
        if (!wrap) return;
        wrap.innerHTML = "";

        const inp = document.createElement("input");
        inp.type = "text";
        inp.className = "cell-edit-input";
        inp.value = (typeof initialChar === "string") ? initialChar : (varies ? "" : firstVal);

        let finished = false;
        const restoreGridFocus = function () {
            const cont = document.getElementById(ctx.containerId);
            if (cont) cont.focus({ preventScroll: true });
        };

        const commitEdit = function (shouldRestoreFocus) {
            if (finished) return;
            finished = true;
            ctx.editingCoord = null;
            const newVal = inp.value;

            // Si la celda editada forma parte de una selección múltiple, aplica a todas las seleccionadas
            if (ctx.selectedCells.size > 1 && ctx.selectedCells.has(cKey)) {
                applyValueToGridSelection(gridId, newVal, cKey);
            } else {
                rowBundle.rows.forEach(function (rObj) {
                    if (!rObj.is_deleted) rObj.cells[colMeta.key] = newVal;
                });
                if (gridId === "main") {
                    renderTableBody();
                    renderUnassignedTableBody();
                } else {
                    renderUnassignedTableBody();
                }
                updateKPIsAndCommitButtons();
            }
            if (shouldRestoreFocus) restoreGridFocus();
        };

        const cancelEdit = function () {
            if (finished) return;
            finished = true;
            ctx.editingCoord = null;
            if (gridId === "main") renderTableBody();
            else renderUnassignedTableBody();
            restoreGridFocus();
        };

        inp.addEventListener("keydown", function (ev) {
            ev.stopPropagation();
            if (ev.key === "Enter") {
                ev.preventDefault();
                commitEdit(true);
            } else if (ev.key === "Escape") {
                ev.preventDefault();
                cancelEdit();
            } else if (ev.key === "Tab") {
                ev.preventDefault();
                commitEdit(true);
            }
        });

        inp.addEventListener("blur", function () {
            commitEdit(false);
        });

        // Soporte Ctrl+V multicelda también estando en edición
        inp.addEventListener("paste", function (ev) {
            const clipText = (ev.clipboardData || window.clipboardData).getData("text");
            if (clipText && (clipText.indexOf("\t") !== -1 || clipText.indexOf("\n") !== -1)) {
                ev.preventDefault();
                finished = true;
                ctx.editingCoord = null;
                applyDirectGridPaste(gridId, clipText, rIdx, cIdx);
            }
        });

        wrap.appendChild(inp);
        inp.focus();
        if (typeof initialChar === "string") {
            inp.setSelectionRange(inp.value.length, inp.value.length);
        } else {
            inp.select();
        }
    }

    function buildInteractiveDataCell(gridId, rowBundle, colMeta, rIdx, cIdx, options) {
        const ctx = appState.grids[gridId];
        const td = document.createElement("td");
        td.className = "ks-td-data" + (colMeta.isReadonly ? " cell-readonly" : "");
        const cKey = cellCoordKey(rIdx, cIdx);
        td.setAttribute("data-cell-coord", cKey);

        const primaryRow = rowBundle.rows[0];
        const isDeleted = rowBundle.rows.every(function (r) { return r.is_deleted; });
        const firstVal = String(primaryRow.cells[colMeta.key] || "");
        let variesInGroup = false;
        if (rowBundle.isCollapsedGroup) {
            for (let i = 1; i < rowBundle.rows.length; i++) {
                if (String(rowBundle.rows[i].cells[colMeta.key] || "") !== firstVal) {
                    variesInGroup = true;
                    break;
                }
            }
        }

        const currentVal = variesInGroup ? "" : firstVal;
        const cellModified = (!rowBundle.isCollapsedGroup && !colMeta.isReadonly)
            ? options.isModifiedFn(primaryRow, colMeta.key)
            : false;

        const replacePreviewVal = (!isDeleted && !variesInGroup && !colMeta.isReadonly && options.replacePreviewFn)
            ? options.replacePreviewFn(currentVal, colMeta.key)
            : null;

        if (replacePreviewVal !== null && replacePreviewVal !== currentVal) {
            if (options.onReplaceMatchCount) options.onReplaceMatchCount();
            const prevDiv = document.createElement("div");
            prevDiv.className = "cell-replace-preview";
            prevDiv.title = "Vista previa de reemplazo: '" + currentVal + "' por '" + replacePreviewVal + "'";
            prevDiv.innerHTML =
                '<span class="preview-old">' + escapeHtml(currentVal) + '</span>' +
                '<span>por</span>' +
                '<span class="preview-new">' + escapeHtml(replacePreviewVal) + '</span>';
            td.appendChild(prevDiv);
            return td;
        }

        const wrap = document.createElement("div");
        wrap.className = "cell-wrapper" + (cellModified ? " cell-modified" : "");

        const disp = document.createElement("div");
        disp.className = "cell-display" + (variesInGroup ? " is-placeholder" : "");
        disp.textContent = variesInGroup ? "<varía>" : currentVal;
        disp.title = currentVal;
        wrap.appendChild(disp);

        // Botón desplegable de valores (triángulo CSS puro, sin iconos)
        if (!colMeta.isReadonly && !isDeleted) {
            const ddBtn = document.createElement("button");
            ddBtn.type = "button";
            ddBtn.className = "cell-dropdown-btn";
            ddBtn.title = "Desplegar opciones existentes";
            ddBtn.innerHTML = '<span class="css-caret"></span>';
            ddBtn.addEventListener("mousedown", function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                openCellDropdown(gridId, td, rIdx, cIdx);
            });
            wrap.appendChild(ddBtn);
        }

        // Botón Deshacer si la celda tiene modificación respecto a Revit
        if (cellModified && options.getOriginalValFn) {
            const origVal = options.getOriginalValFn(primaryRow, colMeta.key);
            const revertBtn = document.createElement("span");
            revertBtn.className = "cell-orig-badge";
            revertBtn.title = "Valor original: '" + (origVal || "(vacío)") + "'. Haz clic para deshacer.";
            revertBtn.textContent = "Deshacer";
            revertBtn.addEventListener("mousedown", function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                primaryRow.cells[colMeta.key] = origVal;
                if (gridId === "main") {
                    renderTableBody();
                    renderUnassignedTableBody();
                } else {
                    renderUnassignedTableBody();
                }
                updateKPIsAndCommitButtons();
            });
            wrap.appendChild(revertBtn);
        }

        td.appendChild(wrap);

        // 1 CLIC / ARRASTRAR / SHIFT+CLIC / CTRL+CLIC -> Selección (NO edita texto)
        td.addEventListener("mousedown", function (ev) {
            if (ev.button !== 0) return;
            if (ctx.editingCoord === cKey) return;

            closeCellDropdown();
            const coord = { r: rIdx, c: cIdx };

            if (ev.shiftKey && ctx.anchor) {
                ev.preventDefault();
                ctx.focus = coord;
                ctx.selectedCells = computeRectSelectionSet(ctx.anchor, ctx.focus);
                updateGridSelectionDOM(gridId);
            } else if (ev.ctrlKey || ev.metaKey) {
                ev.preventDefault();
                if (ctx.selectedCells.has(cKey)) {
                    ctx.selectedCells.delete(cKey);
                } else {
                    ctx.selectedCells.add(cKey);
                    ctx.anchor = coord;
                    ctx.focus = coord;
                }
                updateGridSelectionDOM(gridId);
            } else {
                ctx.anchor = coord;
                ctx.focus = coord;
                ctx.selectedCells = new Set([cKey]);
                ctx.isDragging = true;
                updateGridSelectionDOM(gridId);
            }

            const cont = document.getElementById(ctx.containerId);
            if (cont) cont.focus({ preventScroll: true });
        });

        td.addEventListener("mouseenter", function () {
            const coord = { r: rIdx, c: cIdx };
            if (ctx.isFillDragging && ctx.fillSourceRect) {
                updateFillPreviewForCoord(gridId, coord);
                return;
            }
            if (!ctx.isDragging || !ctx.anchor) return;
            ctx.focus = coord;
            ctx.selectedCells = computeRectSelectionSet(ctx.anchor, ctx.focus);
            updateGridSelectionDOM(gridId);
        });

        // 2 CLICS (DOBLE CLIC) -> Edita texto inline de la celda (y si hay selección múltiple, aplica a todas)
        td.addEventListener("dblclick", function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            if (colMeta.isReadonly || isDeleted) return;
            enterCellInlineEdit(gridId, td, rIdx, cIdx);
        });

        return td;
    }

    function wireGridKeyboardShortcuts(gridId) {
        const ctx = appState.grids[gridId];
        const container = document.getElementById(ctx.containerId);
        if (!container) return;

        container.addEventListener("keydown", function (ev) {
            if (ctx.editingCoord) return;
            // Ignorar si el foco está en un input de filtro de cabecera
            if (document.activeElement && document.activeElement.classList.contains("col-filter-input")) return;
            if (ctx.selectedCells.size === 0 || !ctx.anchor) return;

            const anchorCoord = ctx.anchor;
            const cKey = cellCoordKey(anchorCoord.r, anchorCoord.c);
            const td = container.querySelector('.ks-td-data[data-cell-coord="' + cKey + '"]');

            // Copiar celdas seleccionadas con Ctrl+C
            if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "c") {
                ev.preventDefault();
                copySelectedCellsToClipboard(gridId);
                return;
            }

            // Pegar celdas copiadas con Ctrl+V (soporte portapapeles sistema + fallback interno)
            if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "v") {
                ev.preventDefault();
                const nowTs = Date.now();
                appState.lastPasteTimestamp = nowTs;
                if (navigator.clipboard && navigator.clipboard.readText) {
                    navigator.clipboard.readText().then(function (clipText) {
                        if (clipText) {
                            handleGridPasteText(gridId, clipText);
                        } else if (appState.internalClipboard) {
                            handleGridPasteText(gridId, appState.internalClipboard.tsv);
                        }
                    }).catch(function () {
                        if (appState.internalClipboard) {
                            handleGridPasteText(gridId, appState.internalClipboard.tsv);
                        }
                    });
                } else if (appState.internalClipboard) {
                    handleGridPasteText(gridId, appState.internalClipboard.tsv);
                }
                return;
            }

            if (ev.key === "Delete" || ev.key === "Backspace") {
                ev.preventDefault();
                applyValueToGridSelection(gridId, "", cKey);
                return;
            }

            if (ev.key === "F2" || ev.key === "Enter") {
                ev.preventDefault();
                if (td) enterCellInlineEdit(gridId, td, anchorCoord.r, anchorCoord.c);
                return;
            }

            if ((ev.altKey && ev.key === "ArrowDown") || ev.key === "F4") {
                ev.preventDefault();
                if (td) openCellDropdown(gridId, td, anchorCoord.r, anchorCoord.c);
                return;
            }

            // Navegación con flechas del teclado
            if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].indexOf(ev.key) !== -1 && !ev.altKey) {
                ev.preventDefault();
                const dr = ev.key === "ArrowUp" ? -1 : (ev.key === "ArrowDown" ? 1 : 0);
                const dc = ev.key === "ArrowLeft" ? -1 : (ev.key === "ArrowRight" ? 1 : 0);
                const base = ev.shiftKey && ctx.focus ? ctx.focus : ctx.anchor;
                const nr = Math.max(0, Math.min(ctx.renderedRows.length - 1, base.r + dr));
                const nc = Math.max(0, Math.min(ctx.visibleColumns.length - 1, base.c + dc));

                if (ev.shiftKey) {
                    ctx.focus = { r: nr, c: nc };
                    ctx.selectedCells = computeRectSelectionSet(ctx.anchor, ctx.focus);
                } else {
                    ctx.anchor = { r: nr, c: nc };
                    ctx.focus = { r: nr, c: nc };
                    ctx.selectedCells = new Set([cellCoordKey(nr, nc)]);
                }
                updateGridSelectionDOM(gridId);
                return;
            }

            // Empezar a escribir directamente sobre celda(s) seleccionada(s)
            if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
                ev.preventDefault();
                if (td) enterCellInlineEdit(gridId, td, anchorCoord.r, anchorCoord.c, ev.key);
            }
        });

        // Pegado directo Ctrl+V nativo sobre celda seleccionada (con guard contra doble ejecución con keydown)
        container.addEventListener("paste", function (ev) {
            if (ctx.editingCoord) return;
            if (document.activeElement && document.activeElement.classList.contains("col-filter-input")) return;
            if (!ctx.anchor) return;
            if (Date.now() - appState.lastPasteTimestamp < 120) {
                ev.preventDefault();
                return;
            }
            const clipText = (ev.clipboardData || window.clipboardData).getData("text");
            if (!clipText) return;
            ev.preventDefault();
            handleGridPasteText(gridId, clipText);
        });
    }

    // =========================================================================
    // 7. MAIN KEY SCHEDULE TABLE: FILTERING, SORTING, REPLACE & RENDERING
    // =========================================================================
    function populateFieldFilterDropdowns() {
        if (!appState.state) return;
        const fields = appState.state.active_fields;

        const selFilterField = document.getElementById("selFilterField");
        const prevFilterVal = selFilterField.value;
        selFilterField.innerHTML = '<option value="__ALL__">Todos los campos</option>';

        const selReplaceScope = document.getElementById("selReplaceScopeField");
        const prevReplaceVal = selReplaceScope.value;
        selReplaceScope.innerHTML = '<option value="__ALL__">Toda la tabla (campos activos)</option>';

        fields.forEach(function (f) {
            const o1 = document.createElement("option");
            o1.value = f.key;
            o1.textContent = f.heading || f.name;
            selFilterField.appendChild(o1);

            const o2 = document.createElement("option");
            o2.value = f.key;
            o2.textContent = f.heading || f.name;
            selReplaceScope.appendChild(o2);
        });

        if (prevFilterVal) selFilterField.value = prevFilterVal;
        if (prevReplaceVal) selReplaceScope.value = prevReplaceVal;
    }

    function getFilteredAndSortedRows() {
        if (!appState.state) return [];
        const s = appState.state;
        const fields = s.active_fields;

        const globalQuery = (document.getElementById("txtGlobalFilter").value || "").trim().toLowerCase();
        const specificField = document.getElementById("selFilterField").value;
        const specificOp = document.getElementById("selFilterFieldOp").value;
        const specificVal = (document.getElementById("txtFilterFieldValue").value || "").trim().toLowerCase();

        let result = s.rows.filter(function (row) {
            if (appState.showOnlyModified) {
                if (!row.is_new && !row.is_deleted && !isRowModified(row)) return false;
            }
            if (appState.orphanFilterOnly) {
                if (Number(row.usage_count || 0) > 0) return false;
            }
            if (globalQuery) {
                let matchAny = false;
                for (let i = 0; i < fields.length; i++) {
                    if (String(row.cells[fields[i].key] || "").toLowerCase().indexOf(globalQuery) !== -1) {
                        matchAny = true;
                        break;
                    }
                }
                if (!matchAny) return false;
            }

            const checkFieldMatch = function (cellStr) {
                const c = cellStr.toLowerCase();
                if (specificOp === "empty") return c.trim() === "";
                if (specificOp === "not_empty") return c.trim() !== "";
                if (!specificVal) return true;
                if (specificOp === "equals") return c === specificVal;
                if (specificOp === "starts") return c.indexOf(specificVal) === 0;
                return c.indexOf(specificVal) !== -1;
            };

            if (specificOp === "empty" || specificOp === "not_empty" || specificVal !== "") {
                if (specificField === "__ALL__") {
                    let anyOk = false;
                    for (let i = 0; i < fields.length; i++) {
                        if (checkFieldMatch(String(row.cells[fields[i].key] || ""))) {
                            anyOk = true;
                            break;
                        }
                    }
                    if (!anyOk) return false;
                } else {
                    if (!checkFieldMatch(String(row.cells[specificField] || ""))) return false;
                }
            }

            for (const fKey in appState.columnFilters) {
                const colQ = (appState.columnFilters[fKey] || "").trim().toLowerCase();
                if (!colQ) continue;
                const cellVal = String(row.cells[fKey] || "").toLowerCase();
                if (colQ === "=vacio" || colQ === "=vacío" || colQ === "=") {
                    if (cellVal.trim() !== "") return false;
                } else if (cellVal.indexOf(colQ) === -1) {
                    return false;
                }
            }

            return true;
        });

        if (appState.headerSortField) {
            const sk = appState.headerSortField;
            const dir = appState.headerSortAsc ? 1 : -1;
            result.sort(function (a, b) {
                if (sk === "__USAGE__") {
                    return (Number(a.usage_count || 0) - Number(b.usage_count || 0)) * dir;
                }
                return String(a.cells[sk] || "").localeCompare(String(b.cells[sk] || ""), undefined, {
                    numeric: true,
                    sensitivity: "base"
                }) * dir;
            });
        } else if (s.sort_group && s.sort_group.length > 0) {
            result.sort(function (a, b) {
                for (let i = 0; i < s.sort_group.length; i++) {
                    const sg = s.sort_group[i];
                    const dir = sg.sort_order === "Descending" ? -1 : 1;
                    const cmp = String(a.cells[sg.field_key] || "").localeCompare(
                        String(b.cells[sg.field_key] || ""),
                        undefined,
                        { numeric: true, sensitivity: "base" }
                    );
                    if (cmp !== 0) return cmp * dir;
                }
                return 0;
            });
        }

        return result;
    }

    function computeGenericReplacePreview(barId, findId, replaceId, scopeId, caseId, exactId, currentVal, colKey) {
        const bar = document.getElementById(barId);
        if (!bar || bar.classList.contains("hidden")) return null;
        const findStr = document.getElementById(findId).value || "";
        if (!findStr) return null;
        const scopeField = document.getElementById(scopeId).value;
        if (scopeField !== "__ALL__" && scopeField !== colKey) return null;

        const replaceStr = document.getElementById(replaceId).value || "";
        const caseSensitive = document.getElementById(caseId).checked;
        const exactCell = document.getElementById(exactId).checked;

        const src = String(currentVal || "");
        if (exactCell) {
            const matches = caseSensitive ? (src === findStr) : (src.toLowerCase() === findStr.toLowerCase());
            return matches ? replaceStr : null;
        }
        const flags = caseSensitive ? "g" : "gi";
        const escaped = findStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(escaped, flags);
        if (!regex.test(src)) return null;
        return src.replace(regex, replaceStr);
    }

    function computeMainReplacePreview(currentVal, fieldKey) {
        return computeGenericReplacePreview(
            "replaceBar", "txtFindWord", "txtReplaceWord",
            "selReplaceScopeField", "chkReplaceCase", "chkReplaceExact",
            currentVal, fieldKey
        );
    }

    function executeSearchAndReplace(onlySelectedRows) {
        if (!appState.state) return;
        const findStr = document.getElementById("txtFindWord").value || "";
        if (!findStr) {
            showToast("Introduce el texto que deseas buscar.", "info");
            return;
        }

        const visibleRows = getFilteredAndSortedRows();
        const targetRows = onlySelectedRows
            ? visibleRows.filter(function (r) { return appState.selectedRowIds.has(r.row_id); })
            : visibleRows;

        if (onlySelectedRows && targetRows.length === 0) {
            showToast("No hay filas seleccionadas para aplicar el reemplazo.", "error");
            return;
        }

        let replacedCellsCount = 0;
        appState.state.active_fields.forEach(function (f) {
            targetRows.forEach(function (row) {
                if (row.is_deleted) return;
                const newVal = computeMainReplacePreview(row.cells[f.key], f.key);
                if (newVal !== null && newVal !== row.cells[f.key]) {
                    row.cells[f.key] = newVal;
                    replacedCellsCount++;
                }
            });
        });

        renderTableBody();
        renderUnassignedTableBody();
        updateKPIsAndCommitButtons();
        showToast("Se actualizaron " + replacedCellsCount + " celdas en la previsualización.", "success");
    }

    function ensureTableColGroup(tableEl, colDefs, widthMap) {
        let colGroup = tableEl.querySelector("colgroup");
        if (!colGroup) {
            colGroup = document.createElement("colgroup");
            tableEl.insertBefore(colGroup, tableEl.firstChild);
        }
        colGroup.innerHTML = "";
        const colEls = [];
        colDefs.forEach(function (def) {
            const col = document.createElement("col");
            const w = widthMap[def.id] || def.defaultWidth;
            col.style.width = w + "px";
            colGroup.appendChild(col);
            colEls.push(col);
        });
        return colEls;
    }

    function attachColumnResizeHandle(thEl, colEl, colKey, widthMap, minW, tableEl, colIndex) {
        const handle = document.createElement("div");
        handle.className = "col-resize-handle";
        handle.title = "Arrastra para ajustar el ancho (doble clic para autoajustar)";

        handle.addEventListener("mousedown", function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            const startX = ev.clientX;
            const startW = thEl.getBoundingClientRect().width;
            handle.classList.add("resizing");

            const onMove = function (moveEv) {
                const newW = Math.max(minW, Math.round(startW + (moveEv.clientX - startX)));
                colEl.style.width = newW + "px";
                thEl.style.width = newW + "px";
                widthMap[colKey] = newW;
            };
            const onUp = function () {
                handle.classList.remove("resizing");
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
        });

        handle.addEventListener("click", function (ev) {
            ev.stopPropagation();
        });

        handle.addEventListener("dblclick", function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            // Autoajuste tipo Excel midiendo cabecera y celdas visibles de la columna
            const measurer = document.createElement("span");
            measurer.style.position = "fixed";
            measurer.style.visibility = "hidden";
            measurer.style.whiteSpace = "nowrap";
            measurer.style.font = getComputedStyle(tableEl).font || '12px "Segoe UI", sans-serif';
            document.body.appendChild(measurer);

            let maxW = minW;
            const titleEl = thEl.querySelector(".th-title-text") || thEl;
            measurer.style.fontWeight = "600";
            measurer.textContent = titleEl.textContent || "";
            maxW = Math.max(maxW, Math.ceil(measurer.getBoundingClientRect().width) + 36);

            measurer.style.fontWeight = "400";
            const cells = tableEl.querySelectorAll("tbody tr.ks-row > td:nth-child(" + (colIndex + 1) + ")");
            cells.forEach(function (td) {
                const disp = td.querySelector(".cell-display") || td;
                measurer.textContent = disp.textContent || "";
                const w = Math.ceil(measurer.getBoundingClientRect().width) + 28;
                if (w > maxW) maxW = w;
            });
            document.body.removeChild(measurer);

            const finalW = Math.max(minW, Math.min(480, maxW));
            colEl.style.width = finalW + "px";
            thEl.style.width = finalW + "px";
            widthMap[colKey] = finalW;
        });

        thEl.appendChild(handle);
    }

    function renderTableAll() {
        renderTableHead();
        renderTableBody();
    }

    function renderTableHead() {
        if (!appState.state) return;
        const tableEl = document.getElementById("ksTable");
        const thead = document.getElementById("ksTableHead");
        thead.innerHTML = "";

        const fields = appState.state.active_fields;
        const colDefs = [
            { id: "__CHECK__", defaultWidth: 34, minWidth: 30 },
            { id: "__STATUS__", defaultWidth: 74, minWidth: 55 },
            { id: "__USAGE__", defaultWidth: 92, minWidth: 65 }
        ];
        fields.forEach(function (f) {
            colDefs.push({ id: f.key, defaultWidth: 165, minWidth: 60 });
        });
        const colEls = ensureTableColGroup(tableEl, colDefs, appState.columnWidths);

        const trTitles = document.createElement("tr");

        const thCheck = document.createElement("th");
        thCheck.style.width = colEls[0].style.width;
        thCheck.className = "td-center";
        const chkAll = document.createElement("input");
        chkAll.type = "checkbox";
        chkAll.title = "Seleccionar o deseleccionar filas visibles";
        chkAll.addEventListener("change", function (ev) {
            const vis = getFilteredAndSortedRows();
            vis.forEach(function (r) {
                if (ev.target.checked) appState.selectedRowIds.add(r.row_id);
                else appState.selectedRowIds.delete(r.row_id);
            });
            renderTableBody();
        });
        thCheck.appendChild(chkAll);
        trTitles.appendChild(thCheck);

        const thStatus = document.createElement("th");
        thStatus.style.width = colEls[1].style.width;
        thStatus.textContent = "Estado";
        attachColumnResizeHandle(thStatus, colEls[1], "__STATUS__", appState.columnWidths, 55, tableEl, 1);
        trTitles.appendChild(thStatus);

        const thUsage = document.createElement("th");
        thUsage.style.width = colEls[2].style.width;
        const sortLabelUsage = appState.headerSortField === "__USAGE__"
            ? (appState.headerSortAsc ? "[A-Z]" : "[Z-A]")
            : "";
        thUsage.innerHTML =
            '<div class="th-header-top" title="Cantidad de ejemplares en el modelo que usan esta clave">' +
            '<span class="th-title-text">Usos Modelo</span><span class="th-sort-label">' + sortLabelUsage + '</span></div>';
        thUsage.addEventListener("click", function () {
            if (appState.headerSortField === "__USAGE__") {
                appState.headerSortAsc = !appState.headerSortAsc;
            } else {
                appState.headerSortField = "__USAGE__";
                appState.headerSortAsc = false;
            }
            renderTableHead();
            renderTableBody();
        });
        attachColumnResizeHandle(thUsage, colEls[2], "__USAGE__", appState.columnWidths, 65, tableEl, 2);
        trTitles.appendChild(thUsage);

        fields.forEach(function (f, idx) {
            const colIdx = idx + 3;
            const th = document.createElement("th");
            th.style.width = colEls[colIdx].style.width;
            const hiddenTag = f.is_hidden ? " [Oculto]" : "";
            const headingTitle = (f.heading || f.name) + hiddenTag;

            let sortIndicator = "";
            if (appState.headerSortField === f.key) {
                sortIndicator = appState.headerSortAsc ? "[A-Z]" : "[Z-A]";
            } else {
                const sgIdx = (appState.state.sort_group || []).findIndex(function (sg) { return sg.field_key === f.key; });
                if (sgIdx !== -1 && !appState.headerSortField) {
                    const sgOrd = appState.state.sort_group[sgIdx].sort_order === "Descending" ? "Z-A" : "A-Z";
                    sortIndicator = "[G" + (sgIdx + 1) + " " + sgOrd + "]";
                }
            }

            const topDiv = document.createElement("div");
            topDiv.className = "th-header-top";
            topDiv.innerHTML =
                '<span class="th-title-text">' + escapeHtml(headingTitle) + '</span>' +
                '<span class="th-sort-label">' + sortIndicator + '</span>';

            topDiv.addEventListener("click", function () {
                if (appState.headerSortField === f.key) {
                    appState.headerSortAsc = !appState.headerSortAsc;
                } else {
                    appState.headerSortField = f.key;
                    appState.headerSortAsc = true;
                }
                renderTableHead();
                renderTableBody();
            });

            th.appendChild(topDiv);
            if (f.heading && f.heading !== f.name) {
                const subSpan = document.createElement("span");
                subSpan.className = "th-sub-orig";
                subSpan.textContent = "Parámetro: " + f.name;
                th.appendChild(subSpan);
            }
            attachColumnResizeHandle(th, colEls[colIdx], f.key, appState.columnWidths, 60, tableEl, colIdx);
            trTitles.appendChild(th);
        });

        thead.appendChild(trTitles);

        const trFilters = document.createElement("tr");
        trFilters.className = "col-filter-row";
        trFilters.appendChild(document.createElement("th"));
        trFilters.appendChild(document.createElement("th"));
        trFilters.appendChild(document.createElement("th"));

        fields.forEach(function (f) {
            const thF = document.createElement("th");
            const wrapF = document.createElement("div");
            wrapF.className = "col-filter-wrap";

            const inp = document.createElement("input");
            inp.type = "text";
            inp.className = "col-filter-input";
            inp.placeholder = "Filtrar " + (f.heading || f.name) + "... (o =vacío)";
            inp.value = appState.columnFilters[f.key] || "";
            inp.addEventListener("input", function (ev) {
                appState.columnFilters[f.key] = ev.target.value;
                renderTableBody();
            });

            const btnRep = document.createElement("button");
            btnRep.type = "button";
            btnRep.className = "btn-col-replace";
            btnRep.textContent = "B/S";
            btnRep.title = "Buscar y sustituir en la columna '" + (f.heading || f.name) + "'";
            btnRep.addEventListener("click", function (ev) {
                ev.stopPropagation();
                openColumnReplaceModal("main", f.key, f.heading || f.name);
            });

            wrapF.appendChild(inp);
            wrapF.appendChild(btnRep);
            thF.appendChild(wrapF);
            trFilters.appendChild(thF);
        });

        thead.appendChild(trFilters);
    }

    function buildRevitDisplayItems(sortedRows) {
        const s = appState.state;
        const sortRules = (!appState.headerSortField && s.sort_group) ? s.sort_group : [];
        const isItemized = Boolean(s.is_itemized);
        const fieldMap = {};
        s.active_fields.forEach(function (f) { fieldMap[f.key] = f.heading || f.name; });

        if (sortedRows.length === 0) return [];

        if (sortRules.length === 0) {
            if (isItemized) {
                return sortedRows.map(function (r) {
                    return { type: "data", rows: [r], isCollapsedGroup: false };
                });
            }
            return [{ type: "data", rows: sortedRows, isCollapsedGroup: sortedRows.length > 1 }];
        }

        const displayItems = [];
        const numLevels = sortRules.length;

        function processGroupLevel(rowsSubset, levelIdx) {
            if (rowsSubset.length === 0) return;
            const rule = sortRules[levelIdx];
            const fKey = rule.field_key;
            const fTitle = fieldMap[fKey] || fKey;

            const buckets = [];
            rowsSubset.forEach(function (r) {
                const val = String(r.cells[fKey] || "");
                if (buckets.length === 0 || buckets[buckets.length - 1].val !== val) {
                    buckets.push({ val: val, rows: [r] });
                } else {
                    buckets[buckets.length - 1].rows.push(r);
                }
            });

            buckets.forEach(function (bucket) {
                const displayVal = bucket.val !== "" ? bucket.val : "(sin valor)";
                if (rule.show_header) {
                    displayItems.push({ type: "group_header", level: levelIdx, text: fTitle + ": " + displayVal });
                }
                if (levelIdx + 1 < numLevels) {
                    processGroupLevel(bucket.rows, levelIdx + 1);
                } else if (isItemized) {
                    bucket.rows.forEach(function (r) {
                        displayItems.push({ type: "data", rows: [r], isCollapsedGroup: false });
                    });
                } else {
                    displayItems.push({ type: "data", rows: bucket.rows, isCollapsedGroup: bucket.rows.length > 1 });
                }
                if (rule.show_footer) {
                    displayItems.push({
                        type: "group_footer",
                        level: levelIdx,
                        text: fTitle + " (" + displayVal + ") — Total claves en grupo: " + bucket.rows.length
                    });
                }
                if (rule.show_blank_line) {
                    displayItems.push({ type: "group_blank", level: levelIdx });
                }
            });
        }

        processGroupLevel(sortedRows, 0);
        return displayItems;
    }

    function renderTableBody() {
        if (!appState.state) return;
        const tbody = document.getElementById("ksTableBody");
        tbody.innerHTML = "";

        const fields = appState.state.active_fields;
        const totalColsSpan = fields.length + 3;
        const visibleRows = getFilteredAndSortedRows();

        document.getElementById("emptyTableState").classList.toggle("hidden", visibleRows.length > 0);
        document.getElementById("lblVisibleRowsStatus").textContent =
            "Mostrando " + visibleRows.length + " de " + appState.state.rows.length + " filas";

        const displayItems = buildRevitDisplayItems(visibleRows);

        const ctx = appState.grids.main;
        ctx.renderedRows = [];
        ctx.visibleColumns = fields.map(function (f) {
            return {
                key: f.key,
                name: f.heading || f.name,
                isReadonly: false,
                storageType: f.storage_type || "String"
            };
        });

        let replaceMatchCounter = 0;
        let dataRowCoordIndex = 0;

        displayItems.forEach(function (item) {
            if (item.type === "group_header") {
                const trH = document.createElement("tr");
                trH.className = "revit-group-header level-" + item.level;
                const tdH = document.createElement("td");
                tdH.colSpan = totalColsSpan;
                tdH.textContent = item.text;
                trH.appendChild(tdH);
                tbody.appendChild(trH);
                return;
            }
            if (item.type === "group_footer") {
                const trF = document.createElement("tr");
                trF.className = "revit-group-footer level-" + item.level;
                const tdF = document.createElement("td");
                tdF.colSpan = totalColsSpan;
                tdF.textContent = item.text;
                trF.appendChild(tdF);
                tbody.appendChild(trF);
                return;
            }
            if (item.type === "group_blank") {
                const trB = document.createElement("tr");
                trB.className = "revit-group-blank";
                const tdB = document.createElement("td");
                tdB.colSpan = totalColsSpan;
                trB.appendChild(tdB);
                tbody.appendChild(trB);
                return;
            }

            const rIdx = dataRowCoordIndex++;
            ctx.renderedRows.push(item);

            const groupRows = item.rows;
            const isCollapsed = item.isCollapsedGroup;
            const tr = document.createElement("tr");

            const anyMod = groupRows.some(function (r) { return isRowModified(r); });
            const allDeleted = groupRows.every(function (r) { return r.is_deleted; });
            const allNew = groupRows.every(function (r) { return r.is_new; });
            const allSelected = groupRows.every(function (r) { return appState.selectedRowIds.has(r.row_id); });

            let rowClass = "ks-row";
            if (allSelected) rowClass += " row-selected";
            if (allNew) rowClass += " row-new";
            if (allDeleted) rowClass += " row-deleted";
            tr.className = rowClass;

            const tdCheck = document.createElement("td");
            tdCheck.className = "td-center";
            const chk = document.createElement("input");
            chk.type = "checkbox";
            chk.checked = allSelected;
            chk.addEventListener("change", function (ev) {
                groupRows.forEach(function (r) {
                    if (ev.target.checked) appState.selectedRowIds.add(r.row_id);
                    else appState.selectedRowIds.delete(r.row_id);
                });
                tr.classList.toggle("row-selected", ev.target.checked);
            });
            tdCheck.appendChild(chk);
            tr.appendChild(tdCheck);

            const tdStatus = document.createElement("td");
            tdStatus.className = "td-center";
            const badge = document.createElement("span");
            if (allDeleted) {
                badge.className = "row-status-badge status-del";
                badge.textContent = "ELIMINAR";
            } else if (allNew) {
                badge.className = "row-status-badge status-new";
                badge.textContent = "NUEVA";
            } else if (anyMod) {
                badge.className = "row-status-badge status-mod";
                badge.textContent = "EDITADA";
            } else if (isCollapsed) {
                badge.className = "row-status-badge status-orig";
                badge.textContent = "GRUPO (" + groupRows.length + ")";
            } else {
                badge.className = "row-status-badge status-orig";
                badge.textContent = "OK";
            }
            tdStatus.appendChild(badge);
            tr.appendChild(tdStatus);

            const tdUsage = document.createElement("td");
            tdUsage.className = "td-center";
            const uCount = groupRows.reduce(function (acc, r) { return acc + Number(r.usage_count || 0); }, 0);
            const uSpan = document.createElement("span");
            uSpan.className = "usage-badge " + (uCount > 0 ? "usage-active" : "usage-orphan");
            uSpan.textContent = uCount + (uCount === 1 ? " elem" : " elems");
            tdUsage.appendChild(uSpan);
            tr.appendChild(tdUsage);

            ctx.visibleColumns.forEach(function (colMeta, cIdx) {
                const td = buildInteractiveDataCell("main", item, colMeta, rIdx, cIdx, {
                    isModifiedFn: isCellModified,
                    getOriginalValFn: function (row, key) {
                        const o = appState.originalRowsById[row.row_id];
                        return o ? String(o.cells[key] || "") : "";
                    },
                    replacePreviewFn: computeMainReplacePreview,
                    onReplaceMatchCount: function () { replaceMatchCounter++; }
                });
                tr.appendChild(td);
            });

            tbody.appendChild(tr);
        });

        const lblReplace = document.getElementById("lblReplacePreviewCount");
        if (lblReplace) {
            lblReplace.textContent = replaceMatchCounter + " coincidencias";
        }
        updateGridSelectionDOM("main");
    }

    // =========================================================================
    // 8. TAB 3: HABITACIONES / ELEMENTOS SIN ESTILO (3/4 TABLA + 1/4 PARAMETROS)
    // =========================================================================
    function renderUnassignedTabAll() {
        renderRoomParamsSelector();
        renderUnassignedTableHead();
        renderUnassignedTableBody();
    }

    function populateUnassignedFilterDropdowns() {
        const cols = appState.unassigned.activeColumns || [];
        const selFilter = document.getElementById("selUnassignedFilterField");
        const selReplace = document.getElementById("selUnassignedReplaceField");
        const prevF = selFilter.value;
        const prevR = selReplace.value;

        selFilter.innerHTML = '<option value="__ALL__">Todos los campos</option>';
        selReplace.innerHTML = '<option value="__ALL__">Toda la tabla (editables)</option>';

        cols.forEach(function (pName) {
            const o1 = document.createElement("option");
            o1.value = pName;
            o1.textContent = pName;
            selFilter.appendChild(o1);

            if (!appState.unassigned.readonlyParams.has(pName)) {
                const o2 = document.createElement("option");
                o2.value = pName;
                o2.textContent = pName;
                selReplace.appendChild(o2);
            }
        });

        if (prevF) selFilter.value = prevF;
        if (prevR) selReplace.value = prevR;
    }

    function renderRoomParamsSelector() {
        const listEl = document.getElementById("listRoomParams");
        listEl.innerHTML = "";

        const searchQ = (document.getElementById("txtSearchRoomParams").value || "").trim().toLowerCase();
        const onlyTicked = document.getElementById("chkFilterTickedParams").checked;
        const activeSet = new Set(appState.unassigned.activeColumns);

        const filtered = appState.unassigned.availableParams.filter(function (p) {
            const isTicked = activeSet.has(p.name);
            if (onlyTicked && !isTicked) return false;
            if (searchQ && p.name.toLowerCase().indexOf(searchQ) === -1) return false;
            return true;
        });

        document.getElementById("lblRoomParamsCount").textContent =
            activeSet.size + "/" + appState.unassigned.availableParams.length;

        if (filtered.length === 0) {
            const empty = document.createElement("div");
            empty.className = "hint-text";
            empty.style.padding = "8px";
            empty.textContent = "Sin parámetros que coincidan con el filtro.";
            listEl.appendChild(empty);
            return;
        }

        filtered.forEach(function (p) {
            const row = document.createElement("div");
            row.className = "room-param-item";

            const lbl = document.createElement("label");
            lbl.className = "room-param-label";

            const chk = document.createElement("input");
            chk.type = "checkbox";
            chk.checked = activeSet.has(p.name);
            chk.addEventListener("change", function (ev) {
                toggleRoomParamColumn(p.name, ev.target.checked);
            });

            const spanName = document.createElement("span");
            spanName.className = "room-param-name";
            spanName.textContent = p.name;
            spanName.title = p.name;

            lbl.appendChild(chk);
            lbl.appendChild(spanName);
            row.appendChild(lbl);

            if (p.is_readonly) {
                const ro = document.createElement("span");
                ro.className = "param-ro-tag";
                ro.textContent = "Lectura";
                row.appendChild(ro);
            }

            listEl.appendChild(row);
        });
    }

    function toggleRoomParamColumn(paramName, isChecked) {
        const cols = appState.unassigned.activeColumns;
        const idx = cols.indexOf(paramName);
        if (isChecked && idx === -1) {
            cols.push(paramName);
        } else if (!isChecked && idx !== -1) {
            if (cols.length <= 1) {
                showToast("Debe permanecer al menos una columna visible en la tabla.", "info");
                renderRoomParamsSelector();
                return;
            }
            cols.splice(idx, 1);
        }
        clearGridSelection("unassigned");
        populateUnassignedFilterDropdowns();
        renderRoomParamsSelector();
        renderUnassignedTableHead();
        renderUnassignedTableBody();
    }

    function getFilteredAndSortedUnassignedRows() {
        const u = appState.unassigned;
        const cols = u.activeColumns;

        const globalQ = (document.getElementById("txtUnassignedGlobalFilter").value || "").trim().toLowerCase();
        const specField = document.getElementById("selUnassignedFilterField").value;
        const specOp = document.getElementById("selUnassignedFilterOp").value;
        const specVal = (document.getElementById("txtUnassignedFilterVal").value || "").trim().toLowerCase();

        let result = u.rows.filter(function (row) {
            if (globalQ) {
                let anyMatch = false;
                for (let i = 0; i < cols.length; i++) {
                    if (String(row.cells[cols[i]] || "").toLowerCase().indexOf(globalQ) !== -1) {
                        anyMatch = true;
                        break;
                    }
                }
                if (!anyMatch) return false;
            }

            const checkMatch = function (cellStr) {
                const c = cellStr.toLowerCase();
                if (specOp === "empty") return c.trim() === "";
                if (specOp === "not_empty") return c.trim() !== "";
                if (!specVal) return true;
                if (specOp === "equals") return c === specVal;
                if (specOp === "starts") return c.indexOf(specVal) === 0;
                return c.indexOf(specVal) !== -1;
            };

            if (specOp === "empty" || specOp === "not_empty" || specVal !== "") {
                if (specField === "__ALL__") {
                    let anyOk = false;
                    for (let i = 0; i < cols.length; i++) {
                        if (checkMatch(String(row.cells[cols[i]] || ""))) {
                            anyOk = true;
                            break;
                        }
                    }
                    if (!anyOk) return false;
                } else {
                    if (!checkMatch(String(row.cells[specField] || ""))) return false;
                }
            }

            for (const cKey in u.columnFilters) {
                const colQ = (u.columnFilters[cKey] || "").trim().toLowerCase();
                if (!colQ) continue;
                const cellVal = String(row.cells[cKey] || "").toLowerCase();
                if (colQ === "=vacio" || colQ === "=vacío" || colQ === "=") {
                    if (cellVal.trim() !== "") return false;
                } else if (cellVal.indexOf(colQ) === -1) {
                    return false;
                }
            }
            return true;
        });

        if (u.sortField) {
            const sk = u.sortField;
            const dir = u.sortAsc ? 1 : -1;
            result.sort(function (a, b) {
                return String(a.cells[sk] || "").localeCompare(String(b.cells[sk] || ""), undefined, {
                    numeric: true,
                    sensitivity: "base"
                }) * dir;
            });
        }

        return result;
    }

    function computeUnassignedReplacePreview(currentVal, colKey) {
        return computeGenericReplacePreview(
            "unassignedReplaceBar", "txtUnassignedFind", "txtUnassignedReplace",
            "selUnassignedReplaceField", "chkUnassignedReplaceCase", "chkUnassignedReplaceExact",
            currentVal, colKey
        );
    }

    function executeUnassignedSearchAndReplace(onlySelectedCells) {
        const findStr = document.getElementById("txtUnassignedFind").value || "";
        if (!findStr) {
            showToast("Introduce el texto que deseas buscar.", "info");
            return;
        }

        const ctx = appState.grids.unassigned;
        const visibleRows = getFilteredAndSortedUnassignedRows();
        const cols = appState.unassigned.activeColumns;
        let replaced = 0;

        if (onlySelectedCells) {
            if (ctx.selectedCells.size === 0) {
                showToast("Selecciona primero celdas en la tabla para sustituir.", "error");
                return;
            }
            ctx.selectedCells.forEach(function (coordStr) {
                const parts = coordStr.split(":");
                const rIdx = parseInt(parts[0], 10);
                const cIdx = parseInt(parts[1], 10);
                const rowBundle = ctx.renderedRows[rIdx];
                const colMeta = ctx.visibleColumns[cIdx];
                if (!rowBundle || !colMeta || colMeta.isReadonly) return;
                const row = rowBundle.rows[0];
                const newVal = computeUnassignedReplacePreview(row.cells[colMeta.key], colMeta.key);
                if (newVal !== null && newVal !== row.cells[colMeta.key]) {
                    row.cells[colMeta.key] = newVal;
                    replaced++;
                }
            });
        } else {
            visibleRows.forEach(function (row) {
                cols.forEach(function (colName) {
                    if (appState.unassigned.readonlyParams.has(colName)) return;
                    const newVal = computeUnassignedReplacePreview(row.cells[colName], colName);
                    if (newVal !== null && newVal !== row.cells[colName]) {
                        row.cells[colName] = newVal;
                        replaced++;
                    }
                });
            });
        }

        renderUnassignedTableBody();
        updateKPIsAndCommitButtons();
        showToast("Se actualizaron " + replaced + " celdas en Habitaciones sin Estilo.", "success");
    }

    function renderUnassignedTableHead() {
        const tableEl = document.getElementById("unassignedTable");
        const thead = document.getElementById("unassignedTableHead");
        thead.innerHTML = "";
        const u = appState.unassigned;

        const colDefs = [{ id: "__U_STATUS__", defaultWidth: 74, minWidth: 55 }];
        u.activeColumns.forEach(function (colName) {
            let defW = 160;
            if (colName === "ID") defW = 82;
            else if (colName === u.keyParamName) defW = 200;
            else if (colName === "Name" || colName === "Nombre") defW = 190;
            colDefs.push({ id: colName, defaultWidth: defW, minWidth: 55 });
        });
        const colEls = ensureTableColGroup(tableEl, colDefs, u.columnWidths);

        const trTitles = document.createElement("tr");
        const thState = document.createElement("th");
        thState.style.width = colEls[0].style.width;
        thState.textContent = "Estado";
        attachColumnResizeHandle(thState, colEls[0], "__U_STATUS__", u.columnWidths, 55, tableEl, 0);
        trTitles.appendChild(thState);

        u.activeColumns.forEach(function (colName, idx) {
            const colIdx = idx + 1;
            const th = document.createElement("th");
            th.style.width = colEls[colIdx].style.width;
            const sortLbl = u.sortField === colName ? (u.sortAsc ? "[A-Z]" : "[Z-A]") : "";
            const topDiv = document.createElement("div");
            topDiv.className = "th-header-top";
            topDiv.innerHTML =
                '<span class="th-title-text">' + escapeHtml(colName) + '</span>' +
                '<span class="th-sort-label">' + sortLbl + '</span>';

            topDiv.addEventListener("click", function () {
                if (u.sortField === colName) {
                    u.sortAsc = !u.sortAsc;
                } else {
                    u.sortField = colName;
                    u.sortAsc = true;
                }
                renderUnassignedTableHead();
                renderUnassignedTableBody();
            });

            th.appendChild(topDiv);
            attachColumnResizeHandle(th, colEls[colIdx], colName, u.columnWidths, 55, tableEl, colIdx);
            trTitles.appendChild(th);
        });
        thead.appendChild(trTitles);

        const trFilters = document.createElement("tr");
        trFilters.className = "col-filter-row";
        trFilters.appendChild(document.createElement("th"));

        u.activeColumns.forEach(function (colName) {
            const thF = document.createElement("th");
            const wrapF = document.createElement("div");
            wrapF.className = "col-filter-wrap";

            const inp = document.createElement("input");
            inp.type = "text";
            inp.className = "col-filter-input";
            inp.placeholder = "Filtrar... (o =vacío)";
            inp.value = u.columnFilters[colName] || "";
            inp.addEventListener("input", function (ev) {
                u.columnFilters[colName] = ev.target.value;
                renderUnassignedTableBody();
            });
            wrapF.appendChild(inp);

            if (!u.readonlyParams.has(colName)) {
                const btnRep = document.createElement("button");
                btnRep.type = "button";
                btnRep.className = "btn-col-replace";
                btnRep.textContent = "B/S";
                btnRep.title = "Buscar y sustituir en la columna '" + colName + "'";
                btnRep.addEventListener("click", function (ev) {
                    ev.stopPropagation();
                    openColumnReplaceModal("unassigned", colName, colName);
                });
                wrapF.appendChild(btnRep);
            }

            thF.appendChild(wrapF);
            trFilters.appendChild(thF);
        });
        thead.appendChild(trFilters);
    }

    function renderUnassignedTableBody() {
        const tbody = document.getElementById("unassignedTableBody");
        tbody.innerHTML = "";

        const u = appState.unassigned;
        const visibleRows = getFilteredAndSortedUnassignedRows();

        document.getElementById("emptyUnassignedState").classList.toggle("hidden", visibleRows.length > 0);
        document.getElementById("lblUnassignedStatus").textContent =
            visibleRows.length + " de " + u.rows.length + " sin estilo";

        const paramMetaMap = {};
        u.availableParams.forEach(function (p) { paramMetaMap[p.name] = p; });

        const ctx = appState.grids.unassigned;
        ctx.renderedRows = [];
        ctx.visibleColumns = u.activeColumns.map(function (colName) {
            const meta = paramMetaMap[colName] || {};
            return {
                key: colName,
                name: colName,
                isReadonly: u.readonlyParams.has(colName),
                storageType: meta.storage_type || "String"
            };
        });

        let replaceMatchCount = 0;

        visibleRows.forEach(function (row, rIdx) {
            const bundle = { type: "data", rows: [row], isCollapsedGroup: false };
            ctx.renderedRows.push(bundle);

            const modMap = getUnassignedRowModifiedParams(row);
            const isMod = Object.keys(modMap).length > 0;
            const hasKeyAssigned = String(row.cells[u.keyParamName] || "").trim() !== "";

            const tr = document.createElement("tr");
            tr.className = "ks-row" + (hasKeyAssigned ? " row-new" : "");

            const tdSt = document.createElement("td");
            tdSt.className = "td-center";
            const badge = document.createElement("span");
            if (hasKeyAssigned) {
                badge.className = "row-status-badge status-new";
                badge.textContent = "ASIGNADA";
            } else if (isMod) {
                badge.className = "row-status-badge status-mod";
                badge.textContent = "EDITADA";
            } else {
                badge.className = "row-status-badge status-orig";
                badge.textContent = "SIN CLAVE";
            }
            tdSt.appendChild(badge);
            tr.appendChild(tdSt);

            ctx.visibleColumns.forEach(function (colMeta, cIdx) {
                const td = buildInteractiveDataCell("unassigned", bundle, colMeta, rIdx, cIdx, {
                    isModifiedFn: isUnassignedCellModified,
                    getOriginalValFn: function (rObj, key) {
                        const o = appState.unassigned.originalRowsById[rObj.row_id];
                        return o ? String(o.cells[key] || "") : "";
                    },
                    replacePreviewFn: computeUnassignedReplacePreview,
                    onReplaceMatchCount: function () { replaceMatchCount++; }
                });
                tr.appendChild(td);
            });

            tbody.appendChild(tr);
        });

        const lblRep = document.getElementById("lblUnassignedReplaceCount");
        if (lblRep) lblRep.textContent = replaceMatchCount + " coincidencias";

        updateGridSelectionDOM("unassigned");
    }

    // =========================================================================
    // 9. ROW INSERTION, DUPLICATION, EXCEL PASTE & DELETION
    // =========================================================================
    function generateNextKeyName(basePrefix) {
        const s = appState.state;
        if (!s || s.active_fields.length === 0) return "NEW-01";
        const keyField = s.active_fields[0].key;
        const existingNames = new Set(
            s.rows.map(function (r) { return String(r.cells[keyField] || "").trim().toLowerCase(); })
        );
        let num = s.rows.length + 1;
        const prefix = basePrefix || "KEY-";
        while (true) {
            const padded = num < 10 ? "0" + num : String(num);
            const candidate = prefix + padded;
            if (!existingNames.has(candidate.toLowerCase())) return candidate;
            num++;
        }
    }

    function insertBlankRows(count) {
        if (!appState.state) return;
        const s = appState.state;
        const n = Math.max(1, Math.min(200, Number(count) || 1));
        const allFields = s.active_fields.concat(s.available_fields);
        const keyField = s.active_fields[0] ? s.active_fields[0].key : null;

        for (let i = 0; i < n; i++) {
            const cells = {};
            allFields.forEach(function (f) { cells[f.key] = ""; });
            if (keyField) cells[keyField] = generateNextKeyName("KEY-");
            const tempId = "new_" + (appState.nextTempRowCounter++);
            s.rows.push({
                row_id: tempId,
                element_id: -1,
                is_new: true,
                is_deleted: false,
                usage_count: 0,
                cells: cells
            });
        }

        renderTableBody();
        updateKPIsAndCommitButtons();
        const container = document.getElementById("tableContainer");
        container.scrollTop = container.scrollHeight;
    }

    function duplicateSelectedRows() {
        if (!appState.state) return;
        const s = appState.state;
        const selected = s.rows.filter(function (r) { return appState.selectedRowIds.has(r.row_id); });
        if (selected.length === 0) {
            showToast("Selecciona al menos una fila en la tabla para duplicarla.", "info");
            return;
        }
        const keyField = s.active_fields[0] ? s.active_fields[0].key : null;
        selected.forEach(function (srcRow) {
            const newCells = deepClone(srcRow.cells);
            if (keyField) newCells[keyField] = (newCells[keyField] || "KEY") + "_COPIA";
            s.rows.push({
                row_id: "new_" + (appState.nextTempRowCounter++),
                element_id: -1,
                is_new: true,
                is_deleted: false,
                usage_count: 0,
                cells: newCells
            });
        });
        renderTableBody();
        updateKPIsAndCommitButtons();
        showToast("Se duplicaron " + selected.length + " filas en la vista previa.", "success");
    }

    function toggleDeleteSelectedRows() {
        if (!appState.state) return;
        const s = appState.state;
        const selected = s.rows.filter(function (r) { return appState.selectedRowIds.has(r.row_id); });
        if (selected.length === 0) {
            showToast("Selecciona las filas que deseas eliminar o restaurar.", "info");
            return;
        }
        const newIdsToDrop = new Set();
        let usedKeysWarn = 0;

        selected.forEach(function (r) {
            if (r.is_new) {
                newIdsToDrop.add(r.row_id);
                appState.selectedRowIds.delete(r.row_id);
            } else {
                r.is_deleted = !r.is_deleted;
                if (r.is_deleted && Number(r.usage_count || 0) > 0) usedKeysWarn++;
            }
        });

        if (newIdsToDrop.size > 0) {
            s.rows = s.rows.filter(function (r) { return !newIdsToDrop.has(r.row_id); });
        }
        if (usedKeysWarn > 0) {
            showToast("Atención: " + usedKeysWarn + " clave(s) marcada(s) para eliminar están en uso en el modelo.", "info");
        }
        renderTableBody();
        updateKPIsAndCommitButtons();
    }

    function applyDirectGridPaste(gridId, clipboardText, startGridRowIdx, startColIdx) {
        const ctx = appState.grids[gridId];
        const colsMeta = ctx.visibleColumns;
        const rawLines = clipboardText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();

        let updatedCount = 0;
        let insertedCount = 0;
        let maxColOffset = 0;

        rawLines.forEach(function (line, rOffset) {
            const vals = line.split("\t");
            if (vals.length - 1 > maxColOffset) maxColOffset = vals.length - 1;
            const targetIdx = startGridRowIdx + rOffset;
            let rowBundle = ctx.renderedRows[targetIdx];

            if (!rowBundle) {
                if (gridId !== "main") return; // En habitaciones existentes no se crean habitaciones nuevas al pegar
                const s = appState.state;
                const allFields = s.active_fields.concat(s.available_fields);
                const cells = {};
                allFields.forEach(function (f) { cells[f.key] = ""; });
                const newRowObj = {
                    row_id: "new_" + (appState.nextTempRowCounter++),
                    element_id: -1,
                    is_new: true,
                    is_deleted: false,
                    usage_count: 0,
                    cells: cells
                };
                s.rows.push(newRowObj);
                rowBundle = { type: "data", rows: [newRowObj], isCollapsedGroup: false };
                ctx.renderedRows.push(rowBundle);
                insertedCount++;
            }

            vals.forEach(function (val, cOffset) {
                const colMeta = colsMeta[startColIdx + cOffset];
                if (colMeta && !colMeta.isReadonly) {
                    rowBundle.rows.forEach(function (rObj) {
                        if (!rObj.is_deleted) {
                            rObj.cells[colMeta.key] = val.trim();
                            updatedCount++;
                        }
                    });
                }
            });
        });

        // Seleccionar el bloque recién pegado
        const endR = Math.min(ctx.renderedRows.length - 1, startGridRowIdx + rawLines.length - 1);
        const endC = Math.min(colsMeta.length - 1, startColIdx + maxColOffset);
        if (endR >= startGridRowIdx && endC >= startColIdx) {
            ctx.anchor = { r: startGridRowIdx, c: startColIdx };
            ctx.focus = { r: endR, c: endC };
            ctx.selectedCells = computeRectSelectionSet(ctx.anchor, ctx.focus);
        }

        if (gridId === "main") {
            renderTableBody();
            renderUnassignedTableBody();
        } else {
            renderUnassignedTableBody();
        }
        updateKPIsAndCommitButtons();
        showToast(
            "Pegado desde portapapeles: " + updatedCount + " celdas actualizadas" +
            (insertedCount > 0 ? " y " + insertedCount + " nuevas filas añadidas." : "."),
            "success"
        );
    }

    // =========================================================================
    // MODAL BUSCAR Y SUSTITUIR POR COLUMNA
    // =========================================================================
    function openColumnReplaceModal(gridId, colKey, colTitle) {
        appState.activeColReplace = {
            gridId: gridId,
            colKey: colKey,
            colTitle: colTitle
        };
        document.getElementById("lblColReplaceTitle").textContent =
            "Buscar y Sustituir en columna: \"" + colTitle + "\"";

        // Pre-rellenar si el filtro de esa columna tiene texto normal (no '=vacio')
        const existingColFilter = gridId === "main"
            ? (appState.columnFilters[colKey] || "")
            : (appState.unassigned.columnFilters[colKey] || "");
        const findInp = document.getElementById("txtColFind");
        findInp.value = (existingColFilter && existingColFilter.charAt(0) !== "=") ? existingColFilter : "";
        document.getElementById("txtColReplace").value = "";
        document.getElementById("chkColReplaceCase").checked = false;
        document.getElementById("chkColReplaceExact").checked = false;

        document.getElementById("colReplaceModal").classList.remove("hidden");
        renderColumnReplacePreview();
        setTimeout(function () {
            findInp.focus();
            findInp.select();
        }, 10);
    }

    function closeColumnReplaceModal() {
        document.getElementById("colReplaceModal").classList.add("hidden");
        appState.activeColReplace = null;
    }

    function computeColReplaceValue(srcVal, findStr, replaceStr, caseSensitive, exactCell) {
        if (!findStr) return null;
        const src = String(srcVal || "");
        if (exactCell) {
            const matches = caseSensitive ? (src === findStr) : (src.toLowerCase() === findStr.toLowerCase());
            return matches ? replaceStr : null;
        }
        const flags = caseSensitive ? "g" : "gi";
        const escaped = findStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(escaped, flags);
        if (!regex.test(src)) return null;
        return src.replace(regex, replaceStr);
    }

    function getColumnReplaceCandidates(onlySelectedRows) {
        const info = appState.activeColReplace;
        if (!info) return [];
        const findStr = document.getElementById("txtColFind").value || "";
        const replaceStr = document.getElementById("txtColReplace").value || "";
        const caseSens = document.getElementById("chkColReplaceCase").checked;
        const exactCell = document.getElementById("chkColReplaceExact").checked;
        if (!findStr) return [];

        const matches = [];
        if (info.gridId === "main") {
            const visibleRows = getFilteredAndSortedRows();
            const targetRows = onlySelectedRows
                ? visibleRows.filter(function (r) { return appState.selectedRowIds.has(r.row_id); })
                : visibleRows;

            targetRows.forEach(function (row) {
                if (row.is_deleted) return;
                const oldVal = String(row.cells[info.colKey] || "");
                const newVal = computeColReplaceValue(oldVal, findStr, replaceStr, caseSens, exactCell);
                if (newVal !== null && newVal !== oldVal) {
                    matches.push({ row: row, oldVal: oldVal, newVal: newVal });
                }
            });
        } else {
            const ctx = appState.grids.unassigned;
            const visibleRows = getFilteredAndSortedUnassignedRows();
            let targetRows = visibleRows;
            if (onlySelectedRows) {
                const selectedRowSet = new Set();
                ctx.selectedCells.forEach(function (coordStr) {
                    const rIdx = parseInt(coordStr.split(":")[0], 10);
                    const rb = ctx.renderedRows[rIdx];
                    if (rb && rb.rows[0]) selectedRowSet.add(rb.rows[0]);
                });
                targetRows = visibleRows.filter(function (r) { return selectedRowSet.has(r); });
            }

            targetRows.forEach(function (row) {
                const oldVal = String(row.cells[info.colKey] || "");
                const newVal = computeColReplaceValue(oldVal, findStr, replaceStr, caseSens, exactCell);
                if (newVal !== null && newVal !== oldVal) {
                    matches.push({ row: row, oldVal: oldVal, newVal: newVal });
                }
            });
        }
        return matches;
    }

    function renderColumnReplacePreview() {
        const listEl = document.getElementById("colReplacePreviewList");
        const badgeEl = document.getElementById("lblColReplaceCount");
        listEl.innerHTML = "";

        const findStr = document.getElementById("txtColFind").value || "";
        if (!findStr) {
            badgeEl.textContent = "0 coincidencias";
            const hint = document.createElement("div");
            hint.className = "hint-text";
            hint.style.padding = "10px";
            hint.textContent = "Escribe una palabra o texto en 'Buscar' para ver la vista previa de cambios.";
            listEl.appendChild(hint);
            return;
        }

        const matches = getColumnReplaceCandidates(false);
        badgeEl.textContent = matches.length + (matches.length === 1 ? " coincidencia" : " coincidencias");

        if (matches.length === 0) {
            const empty = document.createElement("div");
            empty.className = "hint-text";
            empty.style.padding = "10px";
            empty.textContent = "No se encontraron coincidencias en las filas visibles de esta columna.";
            listEl.appendChild(empty);
            return;
        }

        matches.slice(0, 120).forEach(function (m) {
            const rowDiv = document.createElement("div");
            rowDiv.className = "col-replace-preview-row";
            rowDiv.innerHTML =
                '<span class="col-replace-old" title="' + escapeHtml(m.oldVal) + '">' +
                escapeHtml(m.oldVal || "(vacío)") + '</span>' +
                '<span class="col-replace-new" title="' + escapeHtml(m.newVal) + '">' +
                escapeHtml(m.newVal || "(vacío)") + '</span>';
            listEl.appendChild(rowDiv);
        });
    }

    function executeColumnReplace(onlySelected) {
        const info = appState.activeColReplace;
        if (!info) return;
        const findStr = document.getElementById("txtColFind").value || "";
        if (!findStr) {
            showToast("Introduce el texto que deseas buscar.", "info");
            return;
        }

        const matches = getColumnReplaceCandidates(onlySelected);
        if (matches.length === 0) {
            showToast(
                onlySelected
                    ? "No hay coincidencias en las filas/celdas seleccionadas."
                    : "No hay coincidencias para sustituir en esta columna.",
                "info"
            );
            return;
        }

        matches.forEach(function (m) {
            m.row.cells[info.colKey] = m.newVal;
        });

        const gridId = info.gridId;
        const colTitle = info.colTitle;
        closeColumnReplaceModal();

        if (gridId === "main") {
            renderTableBody();
            renderUnassignedTableBody();
        } else {
            renderUnassignedTableBody();
        }
        updateKPIsAndCommitButtons();
        showToast(
            "Sustituidas " + matches.length + " celda(s) en la columna '" + colTitle + "'.",
            "success"
        );
    }

    function processModalPaste() {
        const raw = document.getElementById("txtPasteArea").value || "";
        if (!raw.trim()) {
            showToast("Pega primero las celdas copiadas de Excel.", "error");
            return;
        }

        const hasHeaders = document.getElementById("chkPasteFirstRowHeaders").checked;
        const updateExisting = document.getElementById("chkPasteUpdateExisting").checked;
        const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(function (l) {
            return l.trim() !== "";
        });

        const s = appState.state;
        const fields = s.active_fields;
        if (fields.length === 0) return;
        const keyField = fields[0].key;

        let startIdx = hasHeaders ? 1 : 0;
        let inserted = 0;
        let updated = 0;

        for (let i = startIdx; i < lines.length; i++) {
            const cols = lines[i].split("\t");
            const firstColVal = (cols[0] || "").trim();

            let existingRow = null;
            if (updateExisting && firstColVal !== "") {
                existingRow = s.rows.find(function (r) {
                    return !r.is_deleted && String(r.cells[keyField] || "").trim().toLowerCase() === firstColVal.toLowerCase();
                });
            }

            if (existingRow) {
                cols.forEach(function (val, cIdx) {
                    if (fields[cIdx]) existingRow.cells[fields[cIdx].key] = val.trim();
                });
                updated++;
            } else {
                const allFields = s.active_fields.concat(s.available_fields);
                const newCells = {};
                allFields.forEach(function (f) { newCells[f.key] = ""; });
                cols.forEach(function (val, cIdx) {
                    if (fields[cIdx]) newCells[fields[cIdx].key] = val.trim();
                });
                if (!newCells[keyField]) newCells[keyField] = generateNextKeyName("KEY-");
                s.rows.push({
                    row_id: "new_" + (appState.nextTempRowCounter++),
                    element_id: -1,
                    is_new: true,
                    is_deleted: false,
                    usage_count: 0,
                    cells: newCells
                });
                inserted++;
            }
        }

        document.getElementById("pasteModal").classList.add("hidden");
        document.getElementById("txtPasteArea").value = "";
        renderTableBody();
        updateKPIsAndCommitButtons();
        showToast(
            "Datos procesados en vista previa: " + inserted + " filas nuevas, " + updated + " filas actualizadas.",
            "success"
        );
    }

    // =========================================================================
    // 10. RESIZERS (ALTO DE PESTAÑAS + ANCHO ENTRE SUBPANELES)
    // =========================================================================
    function setupPanelResizers() {
        // 1. Resizer Horizontal: Alto de las pestañas superiores
        const hResizer = document.getElementById("panelHeightResizer");
        const bodyWrap = document.getElementById("tabsBodyWrap");
        let isResizingHeight = false;
        let startY = 0;
        let startH = 0;

        hResizer.addEventListener("mousedown", function (ev) {
            ev.preventDefault();
            isResizingHeight = true;
            startY = ev.clientY;
            startH = bodyWrap.getBoundingClientRect().height;
            hResizer.classList.add("resizing");
        });

        hResizer.addEventListener("dblclick", function () {
            const curH = bodyWrap.getBoundingClientRect().height;
            const nextH = curH < 300 ? 370 : 185;
            bodyWrap.style.height = nextH + "px";
            appState.userResizedTabHeight = true;
        });

        // 2. Resizer Vertical en Pestaña 3 (Habitaciones sin Estilo: 3/4 tabla vs 1/4 selector)
        const vUnassigned = document.getElementById("unassignedVerticalResizer");
        const uSplit = document.getElementById("unassignedSplitLayout");
        const uLeft = document.getElementById("unassignedLeftPane");
        let isResizingUnassignedWidth = false;

        vUnassigned.addEventListener("mousedown", function (ev) {
            ev.preventDefault();
            isResizingUnassignedWidth = true;
            vUnassigned.classList.add("resizing");
        });

        // 3. Resizer Vertical en Pestaña 1 (Campos disponibles vs Campos activos)
        const vFields = document.getElementById("fieldsVerticalResizer");
        const fSplit = document.getElementById("fieldsSplitLayout");
        const fLeft = document.getElementById("fieldsLeftPane");
        let isResizingFieldsWidth = false;

        vFields.addEventListener("mousedown", function (ev) {
            ev.preventDefault();
            isResizingFieldsWidth = true;
            vFields.classList.add("resizing");
        });

        window.addEventListener("mousemove", function (ev) {
            if (isResizingHeight) {
                const maxH = Math.max(240, window.innerHeight - 230);
                const newH = Math.max(90, Math.min(maxH, startH + (ev.clientY - startY)));
                bodyWrap.style.height = newH + "px";
                appState.userResizedTabHeight = true;
            }
            if (isResizingUnassignedWidth) {
                const rect = uSplit.getBoundingClientRect();
                const offsetX = ev.clientX - rect.left;
                const pct = Math.max(25, Math.min(88, (offsetX / rect.width) * 100));
                uLeft.style.width = pct + "%";
            }
            if (isResizingFieldsWidth) {
                const rect = fSplit.getBoundingClientRect();
                const actionsEl = fSplit.querySelector(".fields-actions");
                const actionsW = actionsEl ? actionsEl.getBoundingClientRect().width + 8 : 74;
                const offsetX = ev.clientX - rect.left - actionsW;
                const pct = Math.max(18, Math.min(68, (offsetX / rect.width) * 100));
                fLeft.style.width = pct + "%";
            }
        });

        window.addEventListener("mouseup", function () {
            if (isResizingHeight) {
                isResizingHeight = false;
                hResizer.classList.remove("resizing");
            }
            if (isResizingUnassignedWidth) {
                isResizingUnassignedWidth = false;
                vUnassigned.classList.remove("resizing");
            }
            if (isResizingFieldsWidth) {
                isResizingFieldsWidth = false;
                vFields.classList.remove("resizing");
            }
        });
    }

    // =========================================================================
    // 11. COMMIT CHANGES TO REVIT & DISCARD STAGING
    // =========================================================================
    function buildApplyChangesPayload() {
        const s = appState.state;
        const rowsPayload = s.rows.map(function (r) {
            const modKeys = getRowModifiedKeys(r);
            return {
                row_id: r.row_id,
                element_id: r.element_id,
                is_new: Boolean(r.is_new),
                is_deleted: Boolean(r.is_deleted),
                is_modified: modKeys.length > 0,
                modified_keys: modKeys,
                cells: r.cells
            };
        });

        const unassignedUpdates = [];
        appState.unassigned.rows.forEach(function (r) {
            const modParams = getUnassignedRowModifiedParams(r);
            if (Object.keys(modParams).length > 0) {
                unassignedUpdates.push({
                    element_id: r.element_id,
                    modified_params: modParams
                });
            }
        });

        return {
            schedule_id: s.schedule_id,
            active_fields: s.active_fields,
            sort_group: s.sort_group,
            is_itemized: Boolean(s.is_itemized),
            rows: rowsPayload,
            unassigned_updates: unassignedUpdates
        };
    }

    function discardAllStagingChanges() {
        if (!appState.originalData) return;
        loadScheduleIntoState(appState.originalData);
        showToast("Se descartaron todos los cambios en vista previa y se restauró el estado original.", "info");
    }

    // =========================================================================
    // 12. UI UTILITIES & EVENT WIRING
    // =========================================================================
    function escapeHtml(str) {
        return String(str || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function showToast(message, type) {
        const container = document.getElementById("toastContainer");
        const toast = document.createElement("div");
        toast.className = "toast toast-" + (type || "info");
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(function () {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 4200);
    }

    function bindUIEvents() {
        setupPanelResizers();
        wireGridKeyboardShortcuts("main");
        wireGridKeyboardShortcuts("unassigned");

        // Terminar arrastre de celdas o Fill Handle tipo Excel al soltar el ratón
        window.addEventListener("mouseup", function () {
            appState.grids.main.isDragging = false;
            appState.grids.unassigned.isDragging = false;
            if (appState.grids.main.isFillDragging) {
                executeExcelFillDrag("main");
            }
            if (appState.grids.unassigned.isFillDragging) {
                executeExcelFillDrag("unassigned");
            }
        });

        // Eventos del modal Buscar y Sustituir por Columna
        document.getElementById("txtColFind").addEventListener("input", renderColumnReplacePreview);
        document.getElementById("txtColReplace").addEventListener("input", renderColumnReplacePreview);
        document.getElementById("chkColReplaceCase").addEventListener("change", renderColumnReplacePreview);
        document.getElementById("chkColReplaceExact").addEventListener("change", renderColumnReplacePreview);
        document.getElementById("btnCloseColReplaceModal").addEventListener("click", closeColumnReplaceModal);
        document.getElementById("btnCancelColReplace").addEventListener("click", closeColumnReplaceModal);
        document.getElementById("btnApplyColReplaceAll").addEventListener("click", function () {
            executeColumnReplace(false);
        });
        document.getElementById("btnApplyColReplaceSelected").addEventListener("click", function () {
            executeColumnReplace(true);
        });

        // Cerrar desplegable de celda al hacer clic fuera
        window.addEventListener("mousedown", function (ev) {
            const menu = document.getElementById("cellDropdownMenu");
            if (!menu.classList.contains("hidden") && !menu.contains(ev.target)) {
                closeCellDropdown();
            }
        });

        document.getElementById("txtDropdownFilter").addEventListener("input", function (ev) {
            if (!appState.activeDropdown) return;
            renderDropdownOptionsList(appState.activeDropdown.options, ev.target.value);
        });

        document.getElementById("txtDropdownFilter").addEventListener("keydown", function (ev) {
            if (ev.key === "Escape") {
                ev.preventDefault();
                ev.stopPropagation();
                const ddGrid = appState.activeDropdown ? appState.activeDropdown.gridId : null;
                closeCellDropdown();
                if (ddGrid && appState.grids[ddGrid]) {
                    const cont = document.getElementById(appState.grids[ddGrid].containerId);
                    if (cont) cont.focus({ preventScroll: true });
                }
            }
        });

        // Manejo global de Escape dentro de WebView2 (nunca cierra la ventana, solo modales/desplegables)
        window.addEventListener("keydown", function (ev) {
            if (ev.key !== "Escape") return;
            const colRepModal = document.getElementById("colReplaceModal");
            if (colRepModal && !colRepModal.classList.contains("hidden")) {
                ev.preventDefault();
                closeColumnReplaceModal();
                return;
            }
            const pasteModal = document.getElementById("pasteModal");
            if (pasteModal && !pasteModal.classList.contains("hidden")) {
                ev.preventDefault();
                pasteModal.classList.add("hidden");
                return;
            }
            const ddMenu = document.getElementById("cellDropdownMenu");
            if (ddMenu && !ddMenu.classList.contains("hidden")) {
                ev.preventDefault();
                const ddGrid = appState.activeDropdown ? appState.activeDropdown.gridId : null;
                closeCellDropdown();
                if (ddGrid && appState.grids[ddGrid]) {
                    const cont = document.getElementById(appState.grids[ddGrid].containerId);
                    if (cont) cont.focus({ preventScroll: true });
                }
                return;
            }
            if (appState.grids.main.copiedCells.size > 0 || appState.grids.unassigned.copiedCells.size > 0) {
                appState.grids.main.copiedCells.clear();
                appState.grids.unassigned.copiedCells.clear();
                updateGridSelectionDOM("main");
                updateGridSelectionDOM("unassigned");
            }
        });

        // Selector de Key Schedule
        document.getElementById("selSchedule").addEventListener("change", function (ev) {
            const newId = ev.target.value;
            if (!newId) return;
            postToRevit("load_schedule", { schedule_id: Number(newId) });
        });

        document.getElementById("btnRefresh").addEventListener("click", function () {
            postToRevit("refresh_schedules", { schedule_id: appState.currentScheduleId });
        });

        document.getElementById("btnToggleConfig").addEventListener("click", function (ev) {
            const panel = document.getElementById("configPanel");
            const isCollapsed = panel.classList.toggle("collapsed");
            document.getElementById("panelHeightResizer").classList.toggle("hidden-resizer", isCollapsed);
            ev.target.textContent = isCollapsed ? "Mostrar Paneles" : "Ocultar Paneles";
        });

        // Navegación entre las 4 pestañas superiores
        document.querySelectorAll(".tab-btn").forEach(function (btn) {
            btn.addEventListener("click", function () {
                document.querySelectorAll(".tab-btn").forEach(function (b) { b.classList.remove("active"); });
                document.querySelectorAll(".tab-content").forEach(function (c) { c.classList.remove("active"); });
                btn.classList.add("active");
                const targetId = btn.getAttribute("data-tab");
                document.getElementById(targetId).classList.add("active");

                // Si entra a Habitaciones sin Estilo y nunca ajustó el alto manualmente, darle espacio cómodo
                if (targetId === "tabUnassigned" && !appState.userResizedTabHeight) {
                    const bodyWrap = document.getElementById("tabsBodyWrap");
                    if (bodyWrap.getBoundingClientRect().height < 270) {
                        bodyWrap.style.height = "290px";
                    }
                }
            });
        });

        // KPIs interactivos
        document.getElementById("kpiCardChanges").addEventListener("click", function () {
            appState.showOnlyModified = !appState.showOnlyModified;
            document.getElementById("chkShowOnlyModified").checked = appState.showOnlyModified;
            renderTableBody();
            updateKPIsAndCommitButtons();
        });

        document.getElementById("kpiCardOrphans").addEventListener("click", function () {
            appState.orphanFilterOnly = !appState.orphanFilterOnly;
            renderTableBody();
            updateKPIsAndCommitButtons();
        });

        // Tab 1: Campos en Uso
        document.getElementById("txtSearchAvailFields").addEventListener("input", renderTabFields);
        document.getElementById("btnToggleInUseFields").addEventListener("click", function () {
            appState.fieldsLeftFilterInUse = !appState.fieldsLeftFilterInUse;
            renderTabFields();
        });
        document.getElementById("btnAddField").addEventListener("click", addSelectedFieldToSchedule);
        document.getElementById("btnRemoveField").addEventListener("click", removeSelectedFieldFromSchedule);
        document.getElementById("btnMoveFieldUp").addEventListener("click", function () { moveSelectedActiveField(-1); });
        document.getElementById("btnMoveFieldDown").addEventListener("click", function () { moveSelectedActiveField(1); });

        // Tab 2: Agrupación y Orden
        document.getElementById("btnAddSortRule").addEventListener("click", function () {
            if (!appState.state || appState.state.active_fields.length === 0) return;
            if (appState.state.sort_group.length >= 4) {
                showToast("Revit permite hasta 4 niveles de agrupación y ordenación.", "info");
                return;
            }
            appState.state.sort_group.push({
                field_key: appState.state.active_fields[0].key,
                sort_order: "Ascending",
                show_header: false,
                show_footer: false,
                show_blank_line: false
            });
            appState.headerSortField = null;
            renderTabSorting();
            updateTabBadges();
            renderTableHead();
            renderTableBody();
            updateKPIsAndCommitButtons();
        });

        document.getElementById("chkItemizeEveryInstance").addEventListener("change", function (ev) {
            if (!appState.state) return;
            appState.state.is_itemized = ev.target.checked;
            clearGridSelection("main");
            renderTableBody();
            updateKPIsAndCommitButtons();
        });

        // Tab 3: Habitaciones sin Estilo (filtros, selector de parámetros y Buscar/Sustituir)
        document.getElementById("txtSearchRoomParams").addEventListener("input", renderRoomParamsSelector);
        document.getElementById("chkFilterTickedParams").addEventListener("change", renderRoomParamsSelector);

        document.getElementById("txtUnassignedGlobalFilter").addEventListener("input", function () {
            clearGridSelection("unassigned");
            renderUnassignedTableBody();
        });
        document.getElementById("btnClearUnassignedGlobal").addEventListener("click", function () {
            document.getElementById("txtUnassignedGlobalFilter").value = "";
            clearGridSelection("unassigned");
            renderUnassignedTableBody();
        });
        document.getElementById("selUnassignedFilterField").addEventListener("change", function () {
            clearGridSelection("unassigned");
            renderUnassignedTableBody();
        });
        document.getElementById("selUnassignedFilterOp").addEventListener("change", function (ev) {
            const isNoVal = (ev.target.value === "empty" || ev.target.value === "not_empty");
            document.getElementById("txtUnassignedFilterVal").disabled = isNoVal;
            clearGridSelection("unassigned");
            renderUnassignedTableBody();
        });
        document.getElementById("txtUnassignedFilterVal").addEventListener("input", function () {
            clearGridSelection("unassigned");
            renderUnassignedTableBody();
        });
        document.getElementById("btnClearUnassignedFilters").addEventListener("click", function () {
            document.getElementById("txtUnassignedGlobalFilter").value = "";
            document.getElementById("selUnassignedFilterField").value = "__ALL__";
            document.getElementById("selUnassignedFilterOp").value = "contains";
            document.getElementById("txtUnassignedFilterVal").value = "";
            document.getElementById("txtUnassignedFilterVal").disabled = false;
            appState.unassigned.columnFilters = {};
            appState.unassigned.sortField = null;
            clearGridSelection("unassigned");
            renderUnassignedTableHead();
            renderUnassignedTableBody();
        });

        document.getElementById("btnToggleUnassignedReplace").addEventListener("click", function () {
            document.getElementById("unassignedReplaceBar").classList.toggle("hidden");
            renderUnassignedTableBody();
        });
        document.getElementById("txtUnassignedFind").addEventListener("input", renderUnassignedTableBody);
        document.getElementById("txtUnassignedReplace").addEventListener("input", renderUnassignedTableBody);
        document.getElementById("selUnassignedReplaceField").addEventListener("change", renderUnassignedTableBody);
        document.getElementById("chkUnassignedReplaceCase").addEventListener("change", renderUnassignedTableBody);
        document.getElementById("chkUnassignedReplaceExact").addEventListener("change", renderUnassignedTableBody);
        document.getElementById("btnUnassignedReplaceVisible").addEventListener("click", function () {
            executeUnassignedSearchAndReplace(false);
        });
        document.getElementById("btnUnassignedReplaceSelected").addEventListener("click", function () {
            executeUnassignedSearchAndReplace(true);
        });

        // Main Table Toolbar: Filtros Globales y por Campo
        document.getElementById("txtGlobalFilter").addEventListener("input", function () {
            clearGridSelection("main");
            renderTableBody();
        });
        document.getElementById("btnClearGlobalFilter").addEventListener("click", function () {
            document.getElementById("txtGlobalFilter").value = "";
            clearGridSelection("main");
            renderTableBody();
        });
        document.getElementById("selFilterField").addEventListener("change", function () {
            clearGridSelection("main");
            renderTableBody();
        });
        document.getElementById("selFilterFieldOp").addEventListener("change", function (ev) {
            const isNoVal = (ev.target.value === "empty" || ev.target.value === "not_empty");
            document.getElementById("txtFilterFieldValue").disabled = isNoVal;
            clearGridSelection("main");
            renderTableBody();
        });
        document.getElementById("txtFilterFieldValue").addEventListener("input", function () {
            clearGridSelection("main");
            renderTableBody();
        });
        document.getElementById("btnClearAllTableFilters").addEventListener("click", function () {
            document.getElementById("txtGlobalFilter").value = "";
            document.getElementById("selFilterField").value = "__ALL__";
            document.getElementById("selFilterFieldOp").value = "contains";
            document.getElementById("txtFilterFieldValue").value = "";
            document.getElementById("txtFilterFieldValue").disabled = false;
            appState.columnFilters = {};
            appState.orphanFilterOnly = false;
            appState.showOnlyModified = false;
            appState.headerSortField = null;
            clearGridSelection("main");
            document.getElementById("chkShowOnlyModified").checked = false;
            renderTableAll();
            updateKPIsAndCommitButtons();
        });

        // Main Table: Buscar y Sustituir
        document.getElementById("btnToggleReplaceBar").addEventListener("click", function () {
            document.getElementById("replaceBar").classList.toggle("hidden");
            renderTableBody();
        });
        document.getElementById("txtFindWord").addEventListener("input", renderTableBody);
        document.getElementById("txtReplaceWord").addEventListener("input", renderTableBody);
        document.getElementById("selReplaceScopeField").addEventListener("change", renderTableBody);
        document.getElementById("chkReplaceCase").addEventListener("change", renderTableBody);
        document.getElementById("chkReplaceExact").addEventListener("change", renderTableBody);
        document.getElementById("btnExecuteReplaceVisible").addEventListener("click", function () {
            executeSearchAndReplace(false);
        });
        document.getElementById("btnExecuteReplaceSelected").addEventListener("click", function () {
            executeSearchAndReplace(true);
        });

        // Main Table: Insertar, Duplicar, Pegar Excel y Eliminar
        document.getElementById("btnAddRow").addEventListener("click", function () {
            insertBlankRows(document.getElementById("numAddRowsCount").value);
        });
        document.getElementById("btnDuplicateRows").addEventListener("click", duplicateSelectedRows);
        document.getElementById("btnDeleteSelectedRows").addEventListener("click", toggleDeleteSelectedRows);

        document.getElementById("btnOpenPasteModal").addEventListener("click", function () {
            document.getElementById("pasteModal").classList.remove("hidden");
            document.getElementById("txtPasteArea").focus();
        });
        document.getElementById("btnClosePasteModal").addEventListener("click", function () {
            document.getElementById("pasteModal").classList.add("hidden");
        });
        document.getElementById("btnCancelPaste").addEventListener("click", function () {
            document.getElementById("pasteModal").classList.add("hidden");
        });
        document.getElementById("btnConfirmPaste").addEventListener("click", processModalPaste);

        // Footer controls
        document.getElementById("chkShowOnlyModified").addEventListener("change", function (ev) {
            appState.showOnlyModified = ev.target.checked;
            clearGridSelection("main");
            renderTableBody();
            updateKPIsAndCommitButtons();
        });
        document.getElementById("btnDiscardChanges").addEventListener("click", discardAllStagingChanges);
        document.getElementById("btnCloseWindow").addEventListener("click", function () {
            postToRevit("close_window", {});
        });
        document.getElementById("btnApplyChanges").addEventListener("click", function () {
            if (!appState.state) return;
            postToRevit("apply_changes", buildApplyChangesPayload());
        });
    }

    // =========================================================================
    // 13. STANDALONE MOCK DATA (PARA TEST LOCAL EN NAVEGADOR)
    // =========================================================================
    function loadMockDemoData() {
        const mockSchedules = [
            { id: 101, name: "KS_Habitaciones_Acabados", category_name: "Habitaciones", key_param_name: "Estilo de habitación", row_count: 5 }
        ];
        handleIncomingMessage({
            action: "init_data",
            payload: { schedules: mockSchedules, selected_schedule_id: 101 }
        });
        handleIncomingMessage({
            action: "schedule_loaded",
            payload: getMockScheduleDetails(101)
        });
    }

    function getMockScheduleDetails(id) {
        return {
            schedule_id: id,
            schedule_name: "KS_Habitaciones_Acabados",
            category_name: "Habitaciones",
            key_param_name: "Estilo de habitación",
            is_itemized: true,
            total_model_elements: 48,
            active_fields: [
                { key: "param_-1002203", field_id: 0, param_id: -1002203, name: "Key Name", heading: "Key Name", is_hidden: false, is_key_name: true, storage_type: "String" },
                { key: "param_2001", field_id: 1, param_id: 2001, name: "Acabado de Suelo", heading: "Suelo", is_hidden: false, is_key_name: false, storage_type: "String" },
                { key: "param_2002", field_id: 2, param_id: 2002, name: "Acabado de Base", heading: "Rodapié", is_hidden: false, is_key_name: false, storage_type: "String" },
                { key: "param_2003", field_id: 3, param_id: 2003, name: "Acabado de Muro", heading: "Paredes", is_hidden: false, is_key_name: false, storage_type: "String" },
                { key: "param_2004", field_id: 4, param_id: 2004, name: "Acabado de Techo", heading: "Falso Techo", is_hidden: false, is_key_name: false, storage_type: "String" }
            ],
            available_fields: [
                { key: "param_2005", param_id: 2005, name: "Comentarios", heading: "Comentarios", is_hidden: false, is_key_name: false, storage_type: "String" },
                { key: "param_2006", param_id: 2006, name: "Departamento", heading: "Departamento", is_hidden: false, is_key_name: false, storage_type: "String" }
            ],
            sort_group: [
                { field_key: "param_-1002203", sort_order: "Ascending", show_header: false, show_footer: false, show_blank_line: false }
            ],
            rows: [
                { row_id: "501", element_id: 501, is_new: false, is_deleted: false, usage_count: 18, cells: { "param_-1002203": "AC-01 Oficinas General", "param_2001": "Moqueta Modular Gris", "param_2002": "Aluminio Anodizado 8cm", "param_2003": "Pintura Plástica Blanca", "param_2004": "Placa Fonoabsorbente 60x60", "param_2005": "Estándar corporativo", "param_2006": "Oficinas" } },
                { row_id: "502", element_id: 502, is_new: false, is_deleted: false, usage_count: 12, cells: { "param_-1002203": "AC-02 Zonas Húmedas", "param_2001": "Gres Porcelánico Antideslizante", "param_2002": "Gres Porcelánico 10cm", "param_2003": "Alicatado Cerámico Blanco", "param_2004": "Pladur Hidrófugo Pintado", "param_2005": "Aseos y vestuarios", "param_2006": "Servicios" } },
                { row_id: "503", element_id: 503, is_new: false, is_deleted: false, usage_count: 9, cells: { "param_-1002203": "AC-03 Circulaciones", "param_2001": "Piedra Natural Caliza", "param_2002": "Madera Lacada Blanca", "param_2003": "Pintura Plástica Blanca", "param_2004": "Pladur Continuo Fonoabsorbente", "param_2005": "", "param_2006": "Comunes" } },
                { row_id: "504", element_id: 504, is_new: false, is_deleted: false, usage_count: 0, cells: { "param_-1002203": "AC-04 Cuartos Técnicos", "param_2001": "Resina Epoxi Gris", "param_2002": "Sin rodapié", "param_2003": "Hormigón Visto", "param_2004": "Visto sin falso techo", "param_2005": "", "param_2006": "Instalaciones" } },
                { row_id: "505", element_id: 505, is_new: false, is_deleted: false, usage_count: 0, cells: { "param_-1002203": "AC-05 Reserva Antiguo", "param_2001": "Terrazo", "param_2002": "", "param_2003": "Pintura", "param_2004": "", "param_2005": "", "param_2006": "" } }
            ],
            unassigned_data: {
                category_name: "Habitaciones",
                is_rooms_category: true,
                key_param_name: "Estilo de habitación",
                default_columns: ["ID", "Name", "Estilo de habitación"],
                readonly_params: ["ID", "Area", "Level"],
                available_params: [
                    { name: "ID", is_readonly: true, storage_type: "String" },
                    { name: "Name", is_readonly: false, storage_type: "String" },
                    { name: "Estilo de habitación", is_readonly: false, storage_type: "KeyRef" },
                    { name: "Number", is_readonly: false, storage_type: "String" },
                    { name: "Department", is_readonly: false, storage_type: "String" },
                    { name: "Area", is_readonly: true, storage_type: "Double" },
                    { name: "Level", is_readonly: true, storage_type: "ElementId" },
                    { name: "Comments", is_readonly: false, storage_type: "String" }
                ],
                rows: [
                    { row_id: "elem_801", element_id: 801, cells: { "ID": "801", "Name": "Despacho Dirección", "Estilo de habitación": "", "Number": "101", "Department": "Dirección", "Area": "28.50 m²", "Level": "Planta 01", "Comments": "" } },
                    { row_id: "elem_802", element_id: 802, cells: { "ID": "802", "Name": "Aseo Accesible", "Estilo de habitación": "", "Number": "102", "Department": "Servicios", "Area": "5.20 m²", "Level": "Planta 01", "Comments": "Revisar acabado" } },
                    { row_id: "elem_803", element_id: 803, cells: { "ID": "803", "Name": "Sala de Reuniones B", "Estilo de habitación": "", "Number": "103", "Department": "Oficinas", "Area": "34.10 m²", "Level": "Planta 01", "Comments": "" } },
                    { row_id: "elem_804", element_id: 804, cells: { "ID": "804", "Name": "Cuarto RACK", "Estilo de habitación": "", "Number": "104", "Department": "Instalaciones", "Area": "9.00 m²", "Level": "Planta 01", "Comments": "" } }
                ]
            }
        };
    }

    function handleMockBridgeAction(action, payload) {
        if (action === "apply_changes") {
            let ins = 0, upd = 0, del = 0, elUpd = 0;
            const remainingRows = [];
            (payload.rows || []).forEach(function (r) {
                if (r.is_deleted) {
                    if (!r.is_new) del++;
                } else {
                    if (r.is_new) {
                        ins++;
                        r.is_new = false;
                        r.element_id = Math.floor(Math.random() * 9000) + 1000;
                        r.row_id = String(r.element_id);
                    } else if (r.is_modified) {
                        upd++;
                    }
                    r.is_modified = false;
                    remainingRows.push(r);
                }
            });

            const updatedUnassignedRows = [];
            const updatesById = {};
            (payload.unassigned_updates || []).forEach(function (u) {
                updatesById[u.element_id] = u.modified_params || {};
            });

            const keyParam = appState.unassigned.keyParamName;
            appState.unassigned.rows.forEach(function (r) {
                const mod = updatesById[r.element_id];
                if (mod) {
                    elUpd++;
                    Object.keys(mod).forEach(function (k) { r.cells[k] = mod[k]; });
                }
                if (String(r.cells[keyParam] || "").trim() === "") {
                    updatedUnassignedRows.push(r);
                }
            });

            const updatedDetails = deepClone(appState.state);
            updatedDetails.rows = remainingRows;
            updatedDetails.unassigned_data = deepClone(appState.originalData.unassigned_data);
            updatedDetails.unassigned_data.rows = updatedUnassignedRows;

            handleIncomingMessage({
                action: "changes_applied",
                payload: {
                    stats: { inserted: ins, updated: upd, deleted: del, elements_updated: elUpd },
                    schedule_details: updatedDetails
                }
            });
        }
    }

    // =========================================================================
    // INITIALIZE ON DOM READY
    // =========================================================================
    document.addEventListener("DOMContentLoaded", function () {
        bindUIEvents();
        setupBridgeListener();
    });
})();
