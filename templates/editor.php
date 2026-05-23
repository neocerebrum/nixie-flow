<?php /** @var array $diagram */
/** @var array $bootstrap */
?>
<!doctype html>
<html lang="it">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
    <title><?= e($diagram['title']) ?> — Aquata</title>
    <meta name="csrf-token" content="<?= e(\App\Csrf::token()) ?>">
    <meta name="aquata-slug" content="<?= e($diagram['slug']) ?>">
    <link rel="stylesheet" href="/static/app.css">
    <link rel="stylesheet" href="/static/editor.css">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.css">
    <script id="bootstrap-data" type="application/json"><?= json_encode($bootstrap, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG) ?></script>
</head>
<body>
<?php include __DIR__ . '/partials/icons.php'; ?>
<header class="ed-header">
    <a href="/dashboard" class="ed-back" title="Torna alla dashboard">← Dashboard</a>

    <div class="ed-toolbar">
        <button id="undoBtn" class="ed-tb-icon" title="Undo (Ctrl+Z)" aria-label="Undo"><svg class="icon"><use href="#icon-undo"/></svg></button>
        <button id="redoBtn" class="ed-tb-icon" title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><svg class="icon"><use href="#icon-redo"/></svg></button>
        <button id="historyBtn" class="ed-tb-icon" title="Cronologia revisioni" aria-label="Cronologia revisioni"><svg class="icon"><use href="#icon-history"/></svg></button>
        <button id="renameBtn" class="ed-tb-icon" title="Rinomina" aria-label="Rinomina"><svg class="icon"><use href="#icon-rename"/></svg></button>
        <button id="shareBtn" class="ed-tb-icon hidden" title="Condividi" aria-label="Condividi"><svg class="icon"><use href="#icon-share"/></svg></button>
        <button id="exportBtn" class="ed-tb-iconlabel" title="Scarica .mmd" aria-label="Scarica .mmd"><svg class="icon"><use href="#icon-download"/></svg>.mmd</button>
        <button id="exportSvgBtn" class="ed-tb-iconlabel" title="Scarica SVG" aria-label="Scarica SVG"><svg class="icon"><use href="#icon-download"/></svg>SVG</button>
        <button id="exportPngBtn" class="ed-tb-iconlabel" title="Scarica PNG" aria-label="Scarica PNG"><svg class="icon"><use href="#icon-download"/></svg>PNG</button>
        <button id="resetBtn" class="ed-tb-icon" title="Reset layout" aria-label="Reset layout"><svg class="icon"><use href="#icon-reset"/></svg></button>
        <button id="reloadBtn" class="ed-tb-icon" title="Ricarica dal server (scarta modifiche locali)" aria-label="Ricarica"><svg class="icon"><use href="#icon-refresh"/></svg></button>
        <button id="saveBtn" class="ed-tb-iconlabel primary" title="Salva (Ctrl+S)" aria-label="Salva"><svg class="icon"><use href="#icon-save"/></svg>Save</button>
    </div>
    <span id="status"></span>
</header>

<!-- Lock state banner (view-only / lock free / lock mine / lock other) -->
<div id="lockBanner" class="lock-banner">
    <span id="dirtyBadge" class="ed-badge hidden">modificato</span>
    <span id="autosaveBadge" class="ed-badge ed-badge-auto hidden"></span>
    <span class="lock-sep"></span>
    <span id="lockMessage"></span>
    <span id="lockActions"></span>
    <span id="lockViewers" class="lock-viewers"></span>
</div>

<div id="palette">
    <span class="palette-label">Colore:</span>
    <span id="colorPalette"></span>
    <span class="palette-label" style="margin-left: 16px;">Forma:</span>
    <span id="shapePalette"></span>
    <span class="palette-label" style="margin-left: 16px;">Edge:</span>
    <button id="toggleEdgeStyleBtn" class="palette-btn" title="Edge selezionato: continuo ↔ tratteggiato" disabled>↔ Stile</button>
    <button id="cycleEdgeArrowBtn" class="palette-btn" title="Edge selezionato: ciclo freccia → / — / ↔" disabled>→ Freccia</button>
    <button id="reverseEdgeBtn" class="palette-btn" title="Edge selezionato: inverti verso (scambia sorgente/destinazione)" disabled>⇄ Inverti</button>
    <span class="palette-label" style="margin-left: 16px;">Allinea:</span>
    <button id="alignVBtn" class="palette-btn" title="Allinea selezione su Y (alto/centro/basso). Click per ciclare modalità" disabled>↕ centro</button>
    <button id="alignHBtn" class="palette-btn" title="Allinea selezione su X (sinistra/centro/destra). Click per ciclare modalità" disabled>↔ centro</button>
    <button id="distributeHBtn" class="palette-btn" title="Distribuisci selezione orizzontalmente: spaziatura tra nodi uguale, mantenendo gli estremi" disabled>⇆ distrib.</button>
    <button id="distributeVBtn" class="palette-btn" title="Distribuisci selezione verticalmente: spaziatura tra nodi uguale, mantenendo gli estremi" disabled>⇅ distrib.</button>
</div>

<div id="main">
    <aside id="sourcePanel">
        <div class="panel-header">
            <span class="panel-title">Sorgente .mmd</span>
            <span id="parseStatus"></span>
            <button id="togglePanelBtn" title="Collassa">«</button>
        </div>
        <div id="editorHost">
            <textarea id="sourceEditor" spellcheck="false"></textarea>
        </div>
    </aside>
    <div id="resizer" title="Trascina per ridimensionare"></div>
    <div id="canvas">
        <h1 id="diagramTitle" class="canvas-title"><?= e($diagram['title']) ?></h1>
        <button id="fitBtn" class="canvas-fit-btn" title="Fit view (0 / Home)" aria-label="Fit view"><svg class="icon"><use href="#icon-fit"/></svg></button>
        <div id="canvasPad" class="canvas-pad">
            <button id="addNodeBtn" title="Aggiungi nodo (N). Con un subgraph selezionato, il nuovo nodo viene creato al suo interno." aria-label="Aggiungi nodo"><svg class="icon"><use href="#icon-square-plus"/></svg></button>
            <button id="addEdgeBtn" title="Collega (E): seleziona prima un nodo sorgente, poi premi E (o clicca) e infine il target" aria-label="Collega" disabled><svg class="icon"><use href="#icon-arrow-link"/></svg></button>
            <button id="addSubgraphBtn" title="Crea subgraph dai nodi selezionati (≥2, Shift+click per multiselezione)" aria-label="Crea subgraph" disabled><svg class="icon"><use href="#icon-group"/></svg></button>
            <button id="moveToSubgraphBtn" title="Sposta selezione: clicca un subgraph come destinazione (o lo sfondo per la root)" aria-label="Sposta nella subgraph" disabled><svg class="icon"><use href="#icon-log-in"/></svg></button>
            <button id="deleteBtn" class="danger" title="Elimina la selezione (nodo, edge o subgraph)" aria-label="Elimina" disabled><svg class="icon"><use href="#icon-trash"/></svg></button>
        </div>
        <div id="diagram"></div>
    </div>
    <div id="resizerRight" title="Trascina per ridimensionare"></div>
    <aside id="notesPanel">
        <div class="panel-header">
            <button id="toggleNotesPanelBtn" title="Collassa">»</button>
            <span class="panel-title">Note</span>
            <span id="notesTargetLabel" class="notes-target"></span>
        </div>
        <div id="notesBody">
            <div id="notesEmpty" class="notes-empty">
                Seleziona un nodo o un subgraph per modificarne le note.
            </div>
            <textarea id="notesTextarea" class="hidden"
                      spellcheck="false"
                      placeholder="Scrivi qui le note per l'elemento selezionato. Sono salvate nel sorgente come commenti %% (visibili anche da Claude)."></textarea>
        </div>
    </aside>
</div>

<!-- Modal: nuovo nodo -->
<div id="addNodeModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box">
        <h2>Nuovo nodo</h2>
        <label class="field">
            <span>ID <small>(lettere/numeri/_, unico)</small></span>
            <input id="nodeIdInput" type="text" autocomplete="off">
        </label>
        <label class="field">
            <span>Label <small>(vuoto = usa ID)</small></span>
            <input id="nodeLabelInput" type="text" autocomplete="off">
        </label>
        <div class="field">
            <span>Forma</span>
            <div id="shapeGrid"></div>
        </div>
        <div id="addNodeSubgraphHint" class="modal-info hidden"></div>
        <div id="modalError"></div>
        <div class="modal-buttons">
            <button id="nodeCancelBtn">Annulla</button>
            <button id="nodeOkBtn" class="primary">Crea</button>
        </div>
    </div>
</div>

<!-- Modal: conferma generica (riutilizzato per tutte le conferme distruttive) -->
<div id="confirmDialogModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box">
        <h2 id="confirmDialogTitle">Conferma</h2>
        <div id="confirmDialogMessage" class="modal-info"></div>
        <div class="modal-buttons">
            <button id="confirmDialogCancelBtn">Annulla</button>
            <button id="confirmDialogOkBtn" class="primary">Conferma</button>
        </div>
    </div>
</div>

<!-- Modal: nuovo subgraph -->
<div id="addSubgraphModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box">
        <h2>Nuovo subgraph</h2>
        <label class="field">
            <span>ID <small>(lettere/numeri/_, unico)</small></span>
            <input id="subgraphIdInput" type="text" autocomplete="off">
        </label>
        <label class="field">
            <span>Titolo <small>(vuoto = usa ID)</small></span>
            <input id="subgraphTitleInput" type="text" autocomplete="off">
        </label>
        <div id="subgraphMembersInfo" class="modal-info"></div>
        <div id="subgraphModalError"></div>
        <div class="modal-buttons">
            <button id="subgraphCancelBtn">Annulla</button>
            <button id="subgraphOkBtn" class="primary">Crea</button>
        </div>
    </div>
</div>

<!-- Modal: rinomina -->
<div id="renameModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box">
        <h2>Rinomina diagramma</h2>
        <label class="field">
            <span>Titolo</span>
            <input id="renameTitleInput" type="text" autocomplete="off">
        </label>
        <div id="renameError"></div>
        <div class="modal-buttons">
            <button id="renameCancelBtn">Annulla</button>
            <button id="renameOkBtn" class="primary">Salva</button>
        </div>
    </div>
</div>

<!-- Modal: cronologia revisioni -->
<div id="historyModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box modal-wide">
        <h2>Cronologia revisioni</h2>
        <p class="muted-small">Le snapshot sono immutabili: le modifiche dell'editor vivono nel working copy (#current), che viene auto-salvato. La snapshot da cui #current è stata derivata è evidenziata. Cliccando "Carica" copi quella snapshot in #current e continui a editare da lì.</p>
        <div id="historyList" class="history-list"></div>
        <div class="modal-buttons">
            <button id="historyCloseBtn">Chiudi</button>
        </div>
    </div>
</div>

<!-- Modal: conflict -->
<div id="conflictModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box">
        <h2>Conflitto rilevato</h2>
        <p>Qualcun altro (o tu da un altro device) ha salvato una nuova revisione mentre stavi modificando.</p>
        <p><strong>Le tue modifiche locali NON sono state salvate.</strong></p>
        <p>Cosa vuoi fare?</p>
        <div class="modal-buttons modal-buttons-stack">
            <button id="conflictHistoryBtn">Vedi cronologia</button>
            <button id="conflictOverwriteBtn" class="primary">Sovrascrivi (forza save)</button>
            <button id="conflictReloadBtn" class="danger">Ricarica (perdi modifiche)</button>
            <button id="conflictCancelBtn">Annulla</button>
        </div>
    </div>
</div>

<!-- Banner remote update (non-blocking) -->
<div id="remoteUpdateBanner" class="hidden"></div>

<!-- Modal: condividi -->
<div id="shareModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box modal-wide">
        <h2>Condividi diagramma</h2>
        <p class="muted-small">L'utente deve avere già un account. Permesso "view" = sola lettura, "edit" = può modificare e ottenere lo scettro.</p>
        <form id="shareAddForm" class="share-add">
            <input id="shareEmailInput" type="email" placeholder="email@dominio.it" required autocomplete="off">
            <select id="sharePermInput">
                <option value="view">view</option>
                <option value="edit" selected>edit</option>
            </select>
            <button type="submit" class="primary">Aggiungi</button>
        </form>
        <div id="shareError"></div>
        <div id="shareList" class="share-list"></div>
        <div class="modal-buttons">
            <button id="shareCloseBtn">Chiudi</button>
        </div>
    </div>
</div>

<!-- Banner: edit-request (in-bound, when I hold the scepter and someone wants it) -->
<div id="incomingRequestBanner" class="hidden"></div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/mode/simple.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/edit/matchbrackets.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js"></script>
<script src="/static/editor.js"></script>
</body>
</html>
