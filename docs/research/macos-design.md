# macOS-Design (Apple HIG) für eine native-feeling Tauri-App + Update-Monitoring-Strategie

> Recherche-Stand: **2026-06-19**. Zielprojekt: **mads** — native macOS-Desktop-App (Tauri 2 + React/TS, Node-Sidecar mit Claude Agent SDK), Multi-Agent-Dashboard (Main-Integrator + Sub-Agents 1..N je eigene Branch/Worktree).
>
> Bevorzugte Versionen (verifiziert am 2026-06-19): `@anthropic-ai/claude-code` **2.1.183** (dist-tags: stable=2.1.170, latest=2.1.183, next=2.1.183), `@anthropic-ai/claude-agent-sdk` **0.3.183**, `window-vibrancy` **0.7.1**.
>
> Markierungen: **[VERIFIZIERT]** = aus live abgefragter Primärquelle (curl/Doku-Fetch im Recherchelauf). **[UNVERIFIZIERT]** = aus Trainingswissen/allgemeiner HIG-Kenntnis, weil `developer.apple.com/design/...` automatisierte Fetches mit 403/500 blockt; vor Umsetzung an der Original-HIG gegenprüfen.

---

## Teil A — macOS HIG für eine Developer-Tool-/Dashboard-App

### A.0 Mentales Modell: Welche native App ist mads "wie"?

mads gehört zur App-Klasse **Developer Tool / Monitoring-Dashboard** (vgl. Xcode, Tower, Proxyman, TablePlus, OrbStack, GitHub Desktop). Das kanonische Layout dieser Klasse ist **Sidebar + Content + (optional) Inspector**, also das **`NavigationSplitView`-Muster** (zwei- oder dreispaltig). Genau das sollte mads nachbilden.

```
┌──────────────────────────────────────────────────────────────────────┐
│ ●●●  [Toolbar: Title · spacer · Actions · Inspector-Toggle]           │  ← Titlebar/Toolbar (vibrant)
├───────────────┬──────────────────────────────────┬───────────────────┤
│  SIDEBAR      │  CONTENT (Agent-Grid / Detail)    │  INSPECTOR        │
│  (vibrant)    │                                   │  (optional,       │
│  ▸ Agents     │  ┌────────┐ ┌────────┐ ┌────────┐ │   einklappbar)    │
│  ▸ Main       │  │ Agent 1│ │ Agent 2│ │ Agent 3│ │  Diff / Logs /    │
│  ▸ Worktrees  │  │ 🟢 ok  │ │ 🟡 wait│ │ 🔴 esc │ │  Git-Status       │
│  ▸ Activity   │  └────────┘ └────────┘ └────────┘ │                   │
│               │                                   │                   │
│               │  [Live-Terminal-Panel (xterm.js)] │                   │
└───────────────┴──────────────────────────────────┴───────────────────┘
```

### A.1 Fensterstruktur & Traffic-Light-Buttons

| Element | HIG-Empfehlung | Tauri-Umsetzung |
|---|---|---|
| Window-Min-Größe | Developer-Tools brauchen Platz; sinnvoll min. ~900×600 | `minWidth`/`minHeight` in `tauri.conf.json` window-config |
| Titlebar | Für moderne Dashboards: **transparente/überlagernde Titlebar**, damit Sidebar-Material bis nach oben durchläuft | `TitleBarStyle::Transparent` oder `Overlay` (macOS-only) **[VERIFIZIERT]** |
| Traffic-Lights (rot/gelb/grün) | NICHT entfernen. Position ggf. nach unten/rechts versetzen, wenn die Toolbar dort eigene Controls hat | Versatz via `ns_window` cocoa-Call (Position der Buttons setzen) **[UNVERIFIZIERT — exakte API prüfen]** |
| Vollbild | Grün = Fullscreen; Layout muss damit umgehen (Inspector evtl. ausblenden) | Standard-Verhalten |

```rust
// Transparente Titlebar nur auf macOS — verifiziert via Tauri-Doku (tauri.app/learn/window-customization)
use tauri::{TitleBarStyle, WebviewUrl, WebviewWindowBuilder};

let win_builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
    .title("mads")
    .inner_size(1100.0, 720.0)
    .min_inner_size(900.0, 600.0);

#[cfg(target_os = "macos")]
let win_builder = win_builder.title_bar_style(TitleBarStyle::Overlay); // Inhalt läuft unter Toolbar
let window = win_builder.build().unwrap();
```

`TitleBarStyle`-Optionen **[VERIFIZIERT]**: `Visible` (normal), `Transparent` (transparente Titlebar), `Overlay` (Titlebar als Overlay über Content). Für ein Sidebar-Layout, das oben bündig vibrant sein soll, ist `Overlay`/`Transparent` ideal — dann muss das CSS oben einen "drag region"-Streifen reservieren (`data-tauri-drag-region`), damit das Fenster verschiebbar bleibt.

### A.2 Sidebar (NavigationSplitView-Muster) **[UNVERIFIZIERT, gut korroboriert]**

- **Position**: links (leading edge). Einklappbar; Standard-Toggle ist Sidebar-Button in der Toolbar bzw. **⌃⌘S**.
- **Breite**: typ. **150–280 pt**; Developer-Tools tendenziell breiter (Worktree-/Branch-Namen). Bei sehr schmaler Breite ggf. Icon-only.
- **Material**: Sidebars verwenden in SwiftUI/AppKit **automatisch Vibrancy** (behind-window blending) → in mads via `NSVisualEffectMaterial::Sidebar` (siehe A.5).
- **Struktur**: gruppierte Sektionen mit Section-Headern (klein, sekundär, ggf. uppercase). Items mit **SF-Symbol-Icon + Label**.
- **Selektion**: deutlich, aber dezent (Akzentfarbe als gefüllte abgerundete Kapsel hinter dem aktiven Item). Bei Fokusverlust des Fensters: gedämpfte/inaktive Selektion (`selectionInactive`).
- **Für mads**: Sektionen z. B. `Agents` (Main + Sub 1..N), `Worktrees`, `Activity`, `Settings`. Jedes Agent-Item zeigt **Status-Ampel** (kleiner farbiger Punkt) links/rechts vom Label.

### A.3 Toolbar

- Bietet schnellen Zugriff auf häufige Aktionen + Suche. Liegt in/über der Titlebar.
- **Layout**: Title-/Status links, flexibler Spacer, Aktions-Buttons rechts (z. B. „New Agent", „Sync all", Inspector-Toggle, Suche).
- Buttons als **bordlose Symbol-Buttons** (SF Symbols), mit Tooltip + Hilfe-Tag.
- HIG-Konvention: keine überladene Toolbar; gruppieren und Trennzeichen sparsam.

### A.4 Inspector-Panel **[UNVERIFIZIERT, korroboriert]**

- Inspector = **rechte (trailing) tertiäre Spalte** im Split-View; zeigt Detail/Kontext zum aktiven Content-Item.
- HIG: **tertiäre Spalten (Inspector) zuerst ausblenden, wenn das Fenster schmaler wird.** Inspector ist immer einklappbar.
- Für mads: Inspector zeigt zum gewählten Agenten den **Git-Diff**, **PR-Status**, **Logs** oder **Escalation-Details**.
- Toggle-Shortcut-Konvention (modern, macOS 14+): **⌥⌘I** (Inspector ein/aus). **[UNVERIFIZIERT — verifizieren]**

### A.5 Vibrancy / Materials **[VERIFIZIERT (Enum/Tauri) + UNVERIFIZIERT (HIG-Semantik)]**

macOS stellt benannte System-**Materials** bereit, die Translucency/Blur/Vibrancy definieren. Zwei Blend-Modi: **behind-window** (Desktop/Fenster dahinter durchscheinend — für Sidebar, Menü, Popover, Sheet) und **within-window** (Inhalt aus demselben Fenster). Sidebars, Inspectors, Sheets nutzen automatisch Vibrancy; Text auf Material wird „vibrant" gerendert, damit er lesbar bleibt.

In Tauri via Crate **`window-vibrancy`** (v0.7.1). `NSVisualEffectMaterial`-Varianten **[VERIFIZIERT via docs.rs]**:

| Variante | Ab macOS | Empfohlener Einsatz |
|---|---|---|
| `Sidebar` | 10.11+ | **Sidebar-Hintergrund** (für mads die linke Spalte) |
| `HeaderView` | 10.14+ | Header/Section-Bereiche |
| `WindowBackground` | 10.14+ | Allgemeiner Fenster-Hintergrund |
| `ContentBackground` | 10.14+ | Content-Bereich |
| `UnderWindowBackground` | 10.14+ | Hinter Fensterinhalt |
| `HudWindow` | 10.14+ | HUD/Menubar-Apps |
| `Menu` | 10.11+ | Menü-Hintergründe |
| `Popover` | 10.11+ | Popover |
| `Titlebar` | 10.10+ | Titlebar |
| `Selection` | 10.10+ | Selektions-Highlight |
| `Sheet`, `Tooltip`, `FullScreenUI`, `UnderPageBackground` | 10.14+ | jeweils namensgemäß |
| ~~`AppearanceBased`, `Light`, `Dark`, `MediumLight`, `UltraDark`~~ | **deprecated seit 10.14** | NICHT verwenden → semantische Variante nehmen |

```rust
// window-vibrancy 0.7.1 — verifiziert via github.com/tauri-apps/window-vibrancy
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

#[cfg(target_os = "macos")]
apply_vibrancy(
    &window,
    NSVisualEffectMaterial::Sidebar,          // semantisch, NICHT deprecated
    Some(NSVisualEffectState::Active),         // immer aktiv (auch bei Fokusverlust)
    None,                                       // optional: corner radius
).expect("apply_vibrancy nur auf macOS unterstützt");
```

**Pflicht-Konfiguration für Vibrancy/Transparenz [VERIFIZIERT]:**
1. CSS: `html, body { background: transparent; }`
2. `tauri.conf.json` → window: `"transparent": true`
3. `tauri.conf.json`: `"macOSPrivateApi": true` (Vibrancy nutzt private API)

> **Caveat:** `macOSPrivateApi: true` kann je nach App-Store-Policy für Mac-App-Store-Distribution problematisch sein. Für reine Direkt-Distribution (Notarization) unkritisch. Für mads (Developer-Tool, vermutlich Direkt-Download) ok — aber dokumentieren.

**Praxis für mads:** Sidebar = `Sidebar`-Material; Content-Bereich entweder solider Hintergrund (bessere Lesbarkeit bei viel Text/Terminal) oder dezentes `WindowBackground`. **Terminal-Panel und Diff-Views sollten NICHT vibrant sein** — Code/Logs brauchen einen ruhigen, opaken Hintergrund.

### A.6 Light/Dark Mode + Akzentfarbe **[UNVERIFIZIERT, korroboriert]**

- **System-Appearance respektieren** (`prefers-color-scheme`). Eigener Manual-Toggle optional, aber „System" als Default.
- **Akzentfarbe**: macOS erlaubt eine systemweite Accent-Color. Native Apps spiegeln sie. In Web-UI nicht direkt per CSS verfügbar → praktikabler Weg: eigene Markenfarbe ODER `AppKit.NSColor.controlAccentColor` über einen Tauri-Command auslesen und als CSS-Variable injizieren. **[UNVERIFIZIERT — exakter Brückencode zu prüfen]**
- **Semantische Farben**: in beiden Modi getrennte Token (Label/SecondaryLabel/TertiaryLabel, Separator, SystemBackground …). Nicht hart `#000`/`#fff` verwenden.

```css
:root {
  color-scheme: light dark; /* lässt Form-Controls/Scrollbars nativ erscheinen */
  --accent: #007aff;        /* Fallback; ideal aus controlAccentColor injiziert */
  --label: light-dark(#1d1d1f, #f5f5f7);
  --label-secondary: light-dark(rgba(0,0,0,.55), rgba(255,255,255,.55));
  --separator: light-dark(rgba(0,0,0,.1), rgba(255,255,255,.12));
}
```

### A.7 SF Symbols / Icons & Typografie **[UNVERIFIZIERT, korroboriert]**

- **SF Symbols** sind das native Icon-System (>5000 Symbole, gewichts-/größen-anpassbar, Baseline-aligned zu Text). **Lizenz-Caveat:** SF Symbols dürfen primär in Apple-Plattform-UIs verwendet werden; Einbettung als Font/Asset in einer Web-UI ist lizenzrechtlich heikel. **Pragmatische Alternative für mads:** [Lucide](https://lucide.dev) oder [Phosphor](https://phosphoricons.com) — strichbasierte Icon-Sets, die dem SF-Look sehr nahekommen, klar lizenziert (ISC/MIT). Für echtes SF-Feel: konsistente Strichstärke, abgerundete Enden, optische Größe ~16–18 px.
- **Typografie**: **SF Pro** ist die System-Schrift. macOS wählt automatisch **SF Pro Text** (kleinere Größen ≲20 pt) vs. **SF Pro Display** (größere). In Web-UI am einfachsten:
  ```css
  font-family: -apple-system, "SF Pro Text", BlinkMacSystemFont, "Helvetica Neue", sans-serif;
  ```
  `-apple-system`/`BlinkMacSystemFont` zieht die echte System-Schrift in WKWebView (Tauri nutzt WKWebView auf macOS) — kein Font-Bundling nötig.
- **Text-Styles (macOS)**: Large Title, Title 1–3, Headline, Body, Callout, Subheadline, Footnote, Caption 1–2. **Body ~13 pt**, Mindestgröße für Fließtext ~11 pt. Als CSS-Token-Skala abbilden.
- **Monospace** (Terminal/Code): `ui-monospace, "SF Mono", Menlo, monospace` — `ui-monospace` mappt auf SF Mono in WebKit.

### A.8 Spacing / Grid **[UNVERIFIZIERT]**

- macOS-Apps wirken durch **großzügigeres Padding** und feine Trennlinien nativ. Praktikable Basis: **4-pt-Grid** (4/8/12/16/20/24). Control-Höhen ~22–28 px (kompakter als Web-Default).
- Abgerundete Ecken: Cards ~8–10 px, kleine Controls ~6 px. Konsistenz wichtiger als exakte Werte.

### A.9 Tabs vs. Windows; macOS-Menüleiste; Kontextmenüs; Shortcuts

**Tabs vs. Windows [UNVERIFIZIERT, korroboriert]:** macOS unterstützt native Fenster-Tabs (Window-Tabbing). Für mads gibt es zwei Achsen:
- *In-App-Tabs* (z. B. pro Agent ein Tab im Content) → klassisch als In-Content-Segmented/Tab-Bar.
- *Native Window-Tabs* (mehrere mads-Fenster zu Tabs gruppiert) → eher selten nötig; ein einzelnes Dashboard-Fenster mit Sidebar ist idiomatischer als viele Fenster.

**macOS-Menüleiste (oben) [VERIFIZIERT via Tauri-Doku]:** Eine native App MUSS eine echte App-Menüleiste haben (Apple-Menü, App-Menü, File, Edit, View, Window, Help). Tauri erzeugt diese über die native `Menu`/`Submenu`-API; auf macOS landen Top-Level-Items in der Systemmenüleiste, das erste Submenu unter dem App-About-Menü.

```rust
// Native Menüs — Tauri 2 (vereinfacht); Notification-/Menu-API verifiziert via tauri.app
use tauri::menu::{MenuBuilder, SubmenuBuilder};

let app_menu = SubmenuBuilder::new(app, "mads")
    .about(None)
    .separator()
    .text("settings", "Settings…")        // ⌘,
    .separator()
    .quit()                                // ⌘Q
    .build()?;
// ... File / Edit / View(Sidebar/Inspector toggle) / Window / Help analog
let menu = MenuBuilder::new(app).items(&[&app_menu /*, ...*/]).build()?;
app.set_menu(menu)?;
```

**Kontextmenüs [UNVERIFIZIERT]:** Rechtsklick auf Agent-Karte → „Open in Terminal", „Open Worktree", „Create PR", „Stop Agent", „Reveal in Finder". In Tauri über native Menüs (kontextuell anzeigen) oder eine HIG-konforme custom React-Menükomponente; native ist treuer.

**Tastatur-Shortcuts / ⌘-Konventionen [VERIFIZIERT (Support-Doku) + UNVERIFIZIERT (mads-spezifisch)]:**

| Shortcut | Bedeutung | mads-Anwendung |
|---|---|---|
| **⌘,** | Settings/Preferences | App-Settings |
| **⌘N** | New | Neuer Agent / Worktree |
| **⌘W** | Close Window | Fenster/Tab schließen |
| **⌥⌘W** | Close all | alle Fenster |
| **⌘F** | Find/Search | Suche in Logs/Agents |
| **⌃⌘S** | Sidebar ein/aus | Sidebar toggeln |
| **⌥⌘I** | Inspector ein/aus | Inspector toggeln *(verifizieren)* |
| **⌘1..9** | Sektion/Tab wechseln | Zu Agent N springen |
| **⌘R** | Reload/Refresh | Status neu laden |
| **⌘.** | Cancel/Stop | Agent stoppen |

> Eigene Shortcuts dürfen Standard-System-Shortcuts NICHT überschreiben. Shortcuts in den Menüeinträgen anzeigen (macOS rendert sie automatisch rechts im Menü).

---

## Teil B — macOS-Feel in einer React-in-Tauri-UI erreichen

### B.1 Komponenten-Bibliotheken / Design-Systeme

**Wichtige Erkenntnis [VERIFIZIERT durch Recherche]:** Es gibt **kein dominantes, produktionsreifes „AppKit-für-React-Web"-UI-Kit** (Stand 2026-06). Die realistischen Optionen:

| Ansatz | Beschreibung | Empfehlung für mads |
|---|---|---|
| **Tailwind + Headless (React Aria / Radix / Headless UI) + eigene macOS-Token** | Volle Kontrolle, A11y geschenkt, macOS-Look via eigene Token (Materials, Akzent, Spacing) | **EMPFEHLUNG.** Beste Balance aus Kontrolle + Aufwand |
| **React Aria Components** (Adobe) | Verhalten + A11y „headless"; man stylt komplett selbst | Sehr gut als Basis unter Tailwind |
| **shadcn/ui** (Radix + Tailwind, Copy-in) | Komponenten ins Repo kopiert, frei anpassbar | Pragmatisch; Tokens auf macOS umfärben |
| Nischen-„macOS-CSS"-Projekte (z. B. „macOS-Look"-CSS-Frameworks) | meist Hobby/inkonsistent gepflegt | Höchstens als Inspiration |
| Material/Mantine/Chakra | „Material/eigener Look", nicht macOS | NICHT für native Feel |

**Konkrete Stack-Empfehlung:** **React + Tailwind v4 + React Aria Components**, eigene Design-Token-Schicht (Materials/Akzent/Typo wie oben), Icons via **Lucide**, Terminal via **xterm.js**. Den macOS-Feel macht NICHT eine Library, sondern: echte System-Schrift (`-apple-system`), echte Vibrancy (Tauri-Crate), feine Separatoren, kompakte Control-Höhen, korrekte Selektions-/Fokus-States, native Menüs/Notifications.

### B.2 Native Window-Vibrancy via Tauri

Siehe A.5 (Crate `window-vibrancy`, `NSVisualEffectMaterial::Sidebar`, `transparent: true` + `macOSPrivateApi: true` + transparenter CSS-Body).

### B.3 Native Notifications [VERIFIZIERT]

Plugin **`@tauri-apps/plugin-notification`** / `tauri-plugin-notification`.

```ts
import { isPermissionGranted, requestPermission, sendNotification }
  from '@tauri-apps/plugin-notification';

let granted = await isPermissionGranted();
if (!granted) granted = (await requestPermission()) === 'granted';
if (granted) {
  sendNotification({
    title: 'Agent 3 braucht Input',
    body: 'Sub-Agent „feature/payments" wartet auf eine Entscheidung.',
  });
}
```

Rust-seitig analog mit `NotificationExt`, `permission_state()`, `request_permission()`. **Für mads zentral:** „braucht Input"/Escalation-Events → native Notification (siehe C.2). macOS bündelt diese im Notification Center; bei sehr vielen Agenten Throttling/Coalescing einbauen, um Spam zu vermeiden.

### B.4 Native Menüs / Tray [VERIFIZIERT]

- **App-Menüleiste**: native `Menu`/`Submenu`-API (siehe A.9).
- **System-Tray (`TrayIcon`)**: optionales Status-Item in der Menüleiste mit Aggregat-Status (z. B. „3 aktiv, 1 wartet"), Quick-Actions und Tray-Menü. Tauri 2 unterstützt `TrayIcon` mit Menü, Icon, Tooltip, Klick-Events; für reine Menubar-Apps lässt sich das Fenster unter dem Tray-Icon positionieren (`tauri-plugin-positioner`, `Position::TrayBottomCenter`).

> mads-Empfehlung: Tray-Item als „Ambient Status" — selbst wenn das Hauptfenster zu ist, sieht der Mensch am Tray-Icon/Badge, ob Eingriff nötig ist.

---

## Teil C — UI-Patterns für mads (Multi-Agent-Dashboard)

### C.1 Agent-Grid / -Liste mit Status-Ampeln

- **Card-Grid** (responsives Grid) als Default, **Listen-/Tabellenansicht** als Alternative (View-Toggle in Toolbar).
- Jede **Agent-Karte** zeigt: Name/Branch, Worktree-Pfad (gekürzt), **Status-Ampel**, aktuelle Aktivität (1-Zeiler), Fortschritt, Mini-Aktionen (Open Terminal, Open PR, Stop).
- **Status-Farbsemantik** (immer Farbe + Form/Label, nie Farbe allein → A11y):

| Status | Farbe | SF-Symbol-Analog | Bedeutung |
|---|---|---|---|
| Idle / Done | grau / grün | `checkmark.circle` | fertig / nichts zu tun |
| Working | blau (Akzent), animiert | `arrow.triangle.2.circlepath` | arbeitet |
| Needs Input | **gelb/orange** | `exclamationmark.bubble` | wartet auf Mensch |
| Escalation / Error | **rot** | `exclamationmark.triangle` | blockiert / Fehler |

### C.2 „Braucht-Input"-Hervorhebung

Mehrstufig, vom dezentesten zum auffälligsten:
1. **Badge** an der Agent-Karte + Zähler im Sidebar-Item + Dock-/Tray-Badge.
2. **Akzent-Border/Glow** an der Karte (gelb), Karte nach oben sortieren („Needs attention"-Sektion zuerst).
3. **Bounce/Pulse-Animation** dezent — **respektiert Reduced Motion** (siehe D).
4. **Native Notification** (B.3) bei Zustandswechsel `working → needs_input`. Dock-Icon kann **springen** (`requestUserAttention`/Dock-Bounce über Tauri-Window-API; bei macOS „Critical" bounct es bis Fokus). **[UNVERIFIZIERT — Tauri-API `request_user_attention` prüfen]**

> Anti-Noise: Notification NUR bei echtem Übergang in „needs input/escalation", nicht bei jedem Log-Tick. Coalescing: „2 Agenten brauchen Input" statt 2 Einzel-Pings innerhalb kurzer Zeit.

### C.3 Live-Terminal-Panel (xterm.js im macOS-Look) [VERIFIZIERT (ITheme) + UNVERIFIZIERT (Werte)]

- **xterm.js** als Renderer; `@xterm/addon-webgl` (oder canvas) für Performance bei vielen Agenten, `@xterm/addon-fit` fürs Resizing.
- **macOS-Terminal-Feel** über `ITheme` + `fontFamily`:

```ts
import { Terminal } from '@xterm/xterm';
const term = new Terminal({
  fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
  fontSize: 12,
  lineHeight: 1.2,
  cursorBlink: true,
  theme: {
    // macOS "Basic"/Dark-angelehnt — Werte als Startpunkt, an mads-Tokens angleichen
    background: '#1e1e1e',
    foreground: '#f5f5f7',
    cursor: '#f5f5f7',
    selectionBackground: 'rgba(0,122,255,0.35)', // System-Akzent
    black:'#000', red:'#ff5f57', green:'#28c840', yellow:'#febc2e',
    blue:'#007aff', magenta:'#bf5af2', cyan:'#5ac8fa', white:'#f5f5f7',
  },
});
```

`ITheme` unterstützt u. a. `background, foreground, cursor, cursorAccent, selectionBackground/Foreground/Inactive, 16 ANSI-Farben, scrollbarSlider*`. **Wichtig:** Terminal-Panel **opak** halten (kein Vibrancy darunter) für Lesbarkeit. Pro Agent ein eigenes `Terminal`-Instance an seinen Sidecar-Stream gebunden; bei vielen Agenten nur das sichtbare aktiv rendern (Virtualisierung/Lazy-Mount).

### C.4 Fortschrittsdarstellung (determinate vs. indeterminate) [UNVERIFIZIERT, HIG-Standard]

- **Determinate** (Balken mit %) NUR wenn echte Schätzung existiert (z. B. „12/30 Tests", „3/5 Files committed"). Sonst wirkt es unehrlich.
- **Indeterminate** (Spinner/„Activity Indicator") für unbekannte Dauer (Agent „denkt"). macOS: dezenter, kleiner Spinner statt großem Throbber.
- **Mini-Status-Text** („Editing src/…", „Running tests") ist oft wertvoller als ein Balken — Live-Tätigkeit statt Pseudo-Prozent.

### C.5 Eskalations-Banner [UNVERIFIZIERT]

- **Banner** oben im Content (unter Toolbar) oder als prominente Karte ganz oben im Grid, in Rot/Warn-Material, mit klarer Aktion („Resolve conflict", „Approve", „View diff").
- Banner ist **persistent bis behandelt** (im Gegensatz zur transienten Notification). HIG: Alerts/Sheets für blockierende Entscheidungen; Banner für „dringend, aber nicht modal". Für „muss-jetzt-entschieden-werden" → Sheet/Alert mit klaren Buttons (Default-Button rechts, mit Akzentfarbe; destructive rot).

---

## Teil D — Accessibility & Reduced Motion [VERIFIZIERT (Media Queries) + UNVERIFIZIERT (HIG-Details)]

- **`prefers-reduced-motion`**: alle Bounce/Pulse/Slide-Animationen abschalten/auf Crossfade reduzieren. WKWebView spiegelt System „Reduce Motion".
  ```css
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
  ```
- **`prefers-reduced-transparency`** (CSS-Media-Feature, vom System gespiegelt): bei „Reduce Transparency" Vibrancy durch **soliden** Hintergrund ersetzen — sowohl im CSS als auch Vibrancy-Material zur Laufzeit deaktivieren.
  ```css
  @media (prefers-reduced-transparency: reduce) {
    .sidebar { background: var(--solid-sidebar-bg); backdrop-filter: none; }
  }
  ```
- **`prefers-contrast: more`** / „Increase Contrast": Separatoren/Borders verstärken, Text-Kontrast erhöhen.
- **Farbe nie als alleiniger Träger** (Status zusätzlich per Icon/Label) → „Differentiate Without Color".
- **Fokus-Ringe** sichtbar lassen (`:focus-visible`), Tab-Reihenfolge logisch, ARIA-Rollen über React Aria/Radix.
- **VoiceOver**: sinnvolle Labels für Status-Ampeln, Live-Region für eingehende „needs input"-Events.

---

## Teil E — Update-Monitoring: „Sind neue Claude-Code-Funktionen verfügbar?"

### E.1 Überwachbare Quellen (alle live verifiziert am 2026-06-19)

| Quelle | URL | Aktualisierung | ETag/Cond. | Eignung |
|---|---|---|---|---|
| **GitHub Releases (claude-code)** | `github.com/anthropics/claude-code/releases` (API: `api.github.com/repos/anthropics/claude-code/releases`) | pro Version, **Tag = Versionsnr.** (z. B. `v2.1.183`) | **ETag ✓** (304 zählt nicht aufs Limit) | **PRIMÄR** — strukturierte Release-Liste mit Body |
| **GitHub Releases Atom-Feed** | `github.com/anthropics/claude-code/releases.atom` | pro Release | **ETag ✓** (`W/"…"`), `content-type: application/atom+xml` | **PRIMÄR (auth-frei)** — kein Token nötig |
| **CHANGELOG.md (raw)** | `raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md` | pro Release | **ETag ✓** | **PRIMÄR** — voller Changelog-Text zum Diffen |
| **Docs-Changelog (gerendert)** | `code.claude.com/docs/en/changelog` | generiert aus CHANGELOG.md | (HTML) | Sekundär (für Menschen); KEIN RSS/Atom hier |
| **npm: claude-code** | `registry.npmjs.org/@anthropic-ai/claude-code?fields=dist-tags` | bei Publish | **ETag ✓**, `Last-Modified ✓`, `max-age=300` | **PRIMÄR (leicht)** — `stable`/`latest`/`next` |
| **npm: claude-agent-sdk** | `registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest` | bei Publish | **ETag ✓** | **PRIMÄR** — Version des SDK, das der Sidecar nutzt |
| **GitHub Releases (agent-sdk)** | `api.github.com/repos/anthropics/claude-agent-sdk-typescript/releases/latest` | pro Release | **ETag ✓** | SDK-Releases mit Notes |
| **`claude --version` / Update-Mechanismus** | lokal | bei lokalem Update | — | lokaler Ist-Stand (Vergleich „installiert vs. neueste") |

**Verifizierte Fakten [VERIFIZIERT]:**
- `anthropics/claude-code` veröffentlicht **echte GitHub Releases** mit Tags identisch zur npm-Version: aktuell `v2.1.183` (2026-06-19), davor `v2.1.181`, `v2.1.179`.
- npm dist-tags: `stable=2.1.170`, `latest=2.1.183`, `next=2.1.183` → der **`stable`-Tag** ist der konservativste Kanal; mads kann konfigurierbar `stable` vs. `latest` überwachen.
- `@anthropic-ai/claude-agent-sdk` latest = **0.3.183** (Repo: `anthropics/claude-agent-sdk-typescript`), Release-Tag `v0.3.183` (2026-06-19).
- Docs-Changelog wird **aus der GitHub-CHANGELOG.md generiert** (laut Seitentext selbst) → die GitHub-Datei ist die kanonische Quelle; **kein RSS/Atom** auf der Docs-Seite.
- GitHub-REST unauth: **60 req/h** (`x-ratelimit-limit: 60`); mit Token deutlich mehr. **304 (If-None-Match) zählt NICHT aufs Limit.**

### E.2 Polling-Strategie (ETag / If-Modified-Since)

- **Intervall**: 1×/Stunde reicht völlig (Releases kommen ~täglich). Nie aggressiver als nötig.
- **Atom-Feed bevorzugen** (auth-frei, ETag-fähig) für „gibt es etwas Neues?"; bei Treffer **GitHub-API-Release-Objekt** + **CHANGELOG.md** für Details ziehen.
- **Immer conditional**: `If-None-Match: <gespeicherter ETag>` (GitHub/raw/npm) bzw. `If-Modified-Since: <Last-Modified>` (npm). Bei **304 Not Modified** → nichts tun, kein Quota-Verbrauch.
- **State persistieren**: pro Quelle `{etag, last_modified, last_seen_version, last_changelog_hash}`.

```bash
# Conditional Check — Atom-Feed (auth-frei). Nur bei 200 weiterverarbeiten.
ETAG=$(cat ~/.mads/cc_releases.etag 2>/dev/null)
RESP=$(curl -s -D - -o /tmp/cc.atom \
  -H "If-None-Match: ${ETAG}" \
  https://github.com/anthropics/claude-code/releases.atom)
echo "$RESP" | grep -qi '^HTTP/.* 304' && echo "nichts neu" && exit 0
echo "$RESP" | grep -i '^etag:' | awk '{print $2}' | tr -d '\r' > ~/.mads/cc_releases.etag
# -> /tmp/cc.atom enthält neue Releases

# npm: nur dist-tags (winzig), conditional
curl -s -H "If-None-Match: $(cat ~/.mads/cc_npm.etag 2>/dev/null)" \
  -D /tmp/h "https://registry.npmjs.org/@anthropic-ai/claude-code?fields=dist-tags"
```

### E.3 Changelog diffen → Integrations-Vorschlag formulieren

1. **Versions-Diff**: gespeicherte `last_seen_version` vs. neue (aus npm dist-tags oder Release-Tag). Bei Sprung → alle dazwischenliegenden Releases sammeln (GitHub API mit `?per_page=N` ab letzter bekannter).
2. **Changelog-Diff**: neue CHANGELOG-Sektionen extrahieren (alles zwischen `## last_seen_version` und Kopf). Pro Eintrag klassifizieren:
   - **relevant für mads**: Keywords wie `SDK`, `agent`, `subagent`, `MCP`, `hooks`, `permission`, `worktree`, `tool`, `streaming`, `session`, `background agent`, `resume`, `model`.
   - **Rauschen**: reine Windows-/Linux-Fixes, Telemetrie, Docs-Typos, kosmetische TUI-Fixes ohne API-Bezug.
3. **Vorschlag-Synthese**: aus relevanten Einträgen eine knappe Bewertung erzeugen: *Was ist neu? Berührt es mads (UI/Sidecar/SDK)? Konkreter nächster Schritt?* Das ist genau ein LLM-Job (mads kann seinen eigenen Agent dafür nutzen): Input = gefilterte Changelog-Deltas + kurzer mads-Architektur-Kontext, Output = strukturierter Vorschlag.

### E.4 Automatisch als GitHub Issue ins mads-Repo posten (`gh issue create`)

```bash
# Nur posten, wenn relevante Deltas existieren UND noch kein Issue für diese Version offen ist (Idempotenz!)
VERSION="2.1.183"
TITLE="Claude Code ${VERSION}: mögliche Integrationen prüfen"

# Doppelposting vermeiden: nach existierendem Issue mit Label + Versionsmarker suchen
EXISTS=$(gh issue list --repo <owner>/mads \
  --label "cc-update" --state all --search "in:title ${VERSION}" --json number --jq 'length')
[ "$EXISTS" != "0" ] && { echo "Issue für ${VERSION} existiert bereits"; exit 0; }

gh issue create --repo <owner>/mads \
  --title "$TITLE" \
  --label "cc-update,automated" \
  --body "$(cat <<'EOF'
## Neue Claude-Code-Version erkannt

- **Version:** 2.1.183 (npm `latest`; `stable`=2.1.170)
- **Quelle:** https://github.com/anthropics/claude-code/releases/tag/v2.1.183
- **Changelog:** https://code.claude.com/docs/en/changelog
- **SDK (Sidecar):** @anthropic-ai/claude-agent-sdk 0.3.183

### Relevante Änderungen (gefiltert)
- … (auto-extrahierte, mads-relevante Bullet-Points)

### Integrations-Vorschlag (auto-generiert, zu prüfen)
- … (LLM-Synthese: betrifft Sidecar/SDK/UI? konkreter Schritt?)

> Automatisch erstellt vom mads Update-Monitor am 2026-06-19.
EOF
)"
```

**Idempotenz & Anti-Noise (wichtig):**
- Label `cc-update` + Versionsmarker im Titel → vor `create` per `gh issue list --search` prüfen, sonst Doppel-Issues bei jedem Poll.
- Alternativ: **ein** „rolling" Issue pro Minor und neue Versionen als Kommentar (`gh issue comment`) — weniger Issue-Spam.
- Nur Issue erstellen, wenn **relevante** Deltas (E.3) gefunden wurden; reine Bugfix-Releases ggf. nur loggen, nicht eskalieren.
- `gh` nutzt das vorhandene Auth-Token; im mads-Kontext ohnehin vorhanden (volle GitHub-Nutzung).

---

## Quellen

**macOS / HIG / UI:**
- Apple HIG — Sidebars: https://developer.apple.com/design/human-interface-guidelines/sidebars
- Apple HIG — Toolbars: https://developer.apple.com/design/human-interface-guidelines/toolbars
- Apple HIG — Layout: https://developer.apple.com/design/human-interface-guidelines/layout
- Apple HIG — Materials (Foundations): https://developer.apple.com/design/human-interface-guidelines/materials
- Apple HIG — Typography: https://developer.apple.com/design/human-interface-guidelines/typography
- Apple HIG — All Components: https://developer.apple.com/design/human-interface-guidelines/components/all-components
- Apple Support — Mac keyboard shortcuts: https://support.apple.com/en-us/102650
- Reverse Engineering NSVisualEffectView (Oskar Groth): https://oskargroth.com/blog/reverse-engineering-nsvisualeffectview
- Dark Side of the Mac — Appearance & Materials (mackuba.eu): https://mackuba.eu/2018/07/04/dark-side-mac-1/
- MDN — prefers-reduced-transparency: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-transparency

**Tauri / Vibrancy / Native:**
- Tauri 2 — Window Customization (TitleBarStyle, transparent, bg color): https://v2.tauri.app/learn/window-customization (auch tauri.app/learn/window-customization)
- Tauri 2 — Notifications: https://v2.tauri.app/plugin/notification/
- Tauri 2 — Window Menu: https://v2.tauri.app/learn/window-menu/
- Tauri 2 — Config reference (TitleBarStyle, macOSPrivateApi): https://v2.tauri.app/reference/config
- window-vibrancy README: https://github.com/tauri-apps/window-vibrancy/blob/dev/README.md
- window-vibrancy — NSVisualEffectMaterial (docs.rs 0.7.1): https://docs.rs/window-vibrancy/latest/window_vibrancy/enum.NSVisualEffectMaterial.html
- macOS Menu Bar HUD mit Rust + Tauri 2 (DEV): https://dev.to/hiyoyok/how-i-built-a-macos-menu-bar-hud-with-rust-tauri-20-pij

**Terminal:**
- xterm.js — ITheme: https://xtermjs.org/docs/api/terminal/interfaces/itheme/

**Update-Monitoring (live verifiziert 2026-06-19):**
- claude-code Releases: https://github.com/anthropics/claude-code/releases — Atom: https://github.com/anthropics/claude-code/releases.atom
- claude-code CHANGELOG (raw): https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
- Docs-Changelog: https://code.claude.com/docs/en/changelog
- npm @anthropic-ai/claude-code: https://www.npmjs.com/package/@anthropic-ai/claude-code (Registry: https://registry.npmjs.org/@anthropic-ai/claude-code)
- npm @anthropic-ai/claude-agent-sdk: https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk
- agent-sdk-typescript Releases: https://github.com/anthropics/claude-agent-sdk-typescript/releases
- npm Registry API: https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md
- GitHub REST — Best Practices (conditional/ETag/rate limit): https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api

---
*Hinweis: Apple-HIG-Seiten blockieren automatisierte Fetches (403/500). HIG-Aussagen sind aus Such-Snippets der offiziellen Apple-Doku + etablierten Fachquellen rekonstruiert und als [UNVERIFIZIERT] markiert, wo nicht direkt aus einer Live-Quelle bestätigt. Doku-Autoren sollten HIG-Detailwerte an der Original-HIG gegenprüfen.*
