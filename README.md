# UtilitiesPG (pyRevit Extension)

[![pyRevit Version](https://img.shields.io/badge/pyRevit->=4.8.8-blue.svg)](https://github.com/pyrevitlabs/pyRevit)
[![Author](https://img.shields.io/badge/Author-Jos3PG-orange.svg)](https://github.com/Jos3PG)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Colección personal de herramientas, dashboards en WebView2 y utilidades de automatización BIM para Autodesk Revit mediante **pyRevit**, desarrollada por **Jos3PG**.

---

## 🚀 Instalación en pyRevit

### Opción 1: Mediante pyRevit CLI (Recomendado)
Abre tu consola (PowerShell o CMD) y ejecuta:
```bash
pyrevit extend ui UtilitiesPG https://github.com/Jos3PG/pyrevit-utilities-josepg.git
```
Luego recarga pyRevit en Revit (`pyRevit > Reload`).

### Opción 2: Clonado Manual
1. Clona este repositorio dentro de tu carpeta de extensiones de pyRevit (normalmente `%APPDATA%\pyRevit\Extensions\`):
   ```bash
   cd %APPDATA%\pyRevit\Extensions
   git clone https://github.com/Jos3PG/pyrevit-utilities-josepg.git UtilitiesPG.extension
   ```
2. Recarga pyRevit en Revit.

---

## 🛠️ Herramientas Incluidas

### 📦 Panel: Export
* **CSV Export**:
  * Exportación avanzada de Habitaciones (*Rooms*) y Áreas (*Areas*) a formato CSV.
  * Selector intuitivo de parámetros (parámetros de ejemplar y tipo).
  * Soporte para selección de delimitador (`,`, `;`, `\t`, `|`) y calificador de texto (`"`, `'` o ninguno).
  * Sistema de **Presets** para guardar y reutilizar configuraciones de campos y exportación.
  * Interfaz moderna desarrollada en WPF/XAML con manejo seguro de contexto de Revit API.

### 📋 Panel: Schedules
* **Key Schedule Manager (WebView2)**:
  * Gestor y editor integral de **Tablas de Claves (*Key Schedules*)** en WebView2 con paneles de altura y ancho ajustables.
  * **4 Pestañas Superiores**:
    * *Campos en Uso*: Añadir, quitar, reordenar, ocultar, editar encabezados y filtrar parámetros disponibles vs. en uso.
    * *Agrupación y Orden*: Configuración de `ScheduleSortGroupField` y `Detallar cada ejemplar` con previsualización fiel a Revit (encabezados, pies de grupo, líneas en blanco y colapsado `<varía>`).
    * *Habitaciones sin Estilo*: Tabla interactiva (4/5) de elementos/habitaciones sin clave asignada para asignar estilos o editar parámetros, con selector de parámetros con ticks a la derecha (1/5).
    * *KPIs*: Total de claves y cambios pendientes, análisis de *Claves en uso vs. Claves huérfanas*, porcentaje de *Completitud de datos* e impacto en el modelo.
  * **Edición Tipo Excel & Previsualización (*Staging*)**: Selección multicelda (arrastrar, `Shift+Clic`, `Ctrl+Clic`), desplegables de valores únicos/claves al clic, edición inline al doble clic (`Esc` para cancelar sin cerrar la ventana), columnas redimensionables y pegado `Ctrl+V` desde Excel.
  * **Edición Masiva y Filtrado**: *Buscar y sustituir palabras* con vista previa en vivo, *Insertar/Duplicar filas*, *Filtro global*, *Filtro por campo* y confirmación atómica en un `TransactionGroup`.

---

## 🏗️ Arquitectura del Proyecto

Esta extensión sigue las directrices de ingeniería y desacoplamiento de pyRevit:
* **UI Dispatchers (`.pushbutton/script.py`)**: Despachadores ligeros que invocan vistas y controladores sin contener lógica monolítica.
* **Módulos Reutilizables (`lib/`)**:
  * `lib/revit_queries/`: Consultas optimizadas con `FilteredElementCollector` a nivel C++.
  * `lib/csv_exporter/`: Controladores de lógica de exportación, presets y ventanas WPF.
* **WebView2 Ready**: Preparado para dashboards modernos basados en WebView2 con protocolo seguro `ExternalEvent`.

---

## 📄 Licencia
Este proyecto está bajo la Licencia MIT. Consulta el archivo `LICENSE` para más detalles.
