<?php /** @var array $diagram */
/** @var array $bootstrap */
?>
<!doctype html>
<html lang="<?= App\I18n::locale() ?>">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
    <title><?= e($diagram['title']) ?> — Aquata</title>
    <meta name="csrf-token" content="<?= e(\App\Csrf::token()) ?>">
    <meta name="aquata-slug" content="<?= e($diagram['slug']) ?>">
    <link rel="stylesheet" href="<?= e(asset('/static/app.css')) ?>">
    <link rel="stylesheet" href="<?= e(asset('/static/editor.css')) ?>">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.css">
    <script id="bootstrap-data" type="application/json"><?= json_encode($bootstrap, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG) ?></script>
    <script>window.__i18n=<?= json_encode(App\I18n::jsStrings(), JSON_UNESCAPED_UNICODE | JSON_HEX_TAG) ?>;</script>
</head>
<body>
<?php include __DIR__ . '/partials/icons.php'; ?>
<header class="ed-header">
    <a href="/dashboard" class="ed-back" title="<?= __('editor.back') ?>"><?= __('editor.back_short') ?></a>
    <a id="originBackBtn" class="ed-back ed-origin-back hidden" href="#"></a>

    <div class="ed-toolbar">
        <button id="undoBtn" class="ed-tb-icon" title="<?= __('editor.undo') ?>" aria-label="Undo"><svg class="icon"><use href="#icon-undo"/></svg></button>
        <button id="redoBtn" class="ed-tb-icon" title="<?= __('editor.redo') ?>" aria-label="Redo"><svg class="icon"><use href="#icon-redo"/></svg></button>
        <button id="historyBtn" class="ed-tb-icon" title="<?= __('editor.history') ?>" aria-label="<?= __('editor.history') ?>"><svg class="icon"><use href="#icon-history"/></svg></button>
        <button id="renameBtn" class="ed-tb-icon" title="<?= __('editor.rename') ?>" aria-label="<?= __('editor.rename') ?>"><svg class="icon"><use href="#icon-rename"/></svg></button>
        <button id="shareBtn" class="ed-tb-icon hidden" title="<?= __('editor.share') ?>" aria-label="<?= __('editor.share') ?>"><svg class="icon"><use href="#icon-share"/></svg></button>
        <button id="exportBtn" class="ed-tb-iconlabel" title="<?= __('editor.export_mmd') ?>" aria-label="<?= __('editor.export_mmd') ?>"><svg class="icon"><use href="#icon-download"/></svg>.mmd</button>
        <button id="exportSvgBtn" class="ed-tb-iconlabel" title="<?= __('editor.export_svg') ?>" aria-label="<?= __('editor.export_svg') ?>"><svg class="icon"><use href="#icon-download"/></svg>SVG</button>
        <button id="exportPngBtn" class="ed-tb-iconlabel" title="<?= __('editor.export_png') ?>" aria-label="<?= __('editor.export_png') ?>"><svg class="icon"><use href="#icon-download"/></svg>PNG</button>
        <button id="resetBtn" class="ed-tb-icon" title="<?= __('editor.reset_layout') ?>" aria-label="<?= __('editor.reset_layout') ?>"><svg class="icon"><use href="#icon-reset"/></svg></button>
        <button id="reloadBtn" class="ed-tb-icon" title="<?= __('editor.reload_title') ?>" aria-label="<?= __('editor.reload') ?>"><svg class="icon"><use href="#icon-refresh"/></svg></button>
        <button id="tidyBtn" class="ed-tb-icon" title="<?= __('editor.tidy_title') ?>" aria-label="<?= __('editor.tidy') ?>"><svg class="icon"><use href="#icon-sparkles"/></svg></button>
        <button id="saveBtn" class="ed-tb-iconlabel primary" title="<?= __('editor.save') ?>"><svg class="icon"><use href="#icon-save"/></svg><?= __('common.save') ?></button>
    </div>
    <span id="status"></span>
</header>

<!-- Lock state banner (view-only / lock free / lock mine / lock other) -->
<div id="lockBanner" class="lock-banner">
    <span id="dirtyBadge" class="ed-badge hidden"><?= __('editor.modified') ?></span>
    <span id="autosaveBadge" class="ed-badge ed-badge-auto hidden"></span>
    <span class="lock-sep"></span>
    <span id="lockMessage"></span>
    <span id="lockActions"></span>
    <span id="lockViewers" class="lock-viewers"></span>
</div>

<div id="palette">
    <span class="palette-label" id="paletteGroupLabel"><?= __('editor.color') ?></span>
    <span id="colorPalette"></span>
    <span class="palette-label" style="margin-left: 16px;"><?= __('editor.shape') ?></span>
    <span id="shapePalette"></span>
    <span class="palette-label" style="margin-left: 16px;"><?= __('editor.edge') ?></span>
    <button id="toggleEdgeStyleBtn" class="palette-btn" title="<?= __('editor.edge_style_title') ?>" disabled><?= __('editor.edge_style') ?></button>
    <button id="cycleEdgeArrowBtn" class="palette-btn" title="<?= __('editor.edge_arrow_title') ?>" disabled><?= __('editor.edge_arrow') ?></button>
    <button id="reverseEdgeBtn" class="palette-btn" title="<?= __('editor.edge_reverse_title') ?>" disabled><?= __('editor.edge_reverse') ?></button>
    <span class="palette-label" style="margin-left: 16px;"><?= __('editor.align') ?></span>
    <button id="alignVBtn" class="palette-btn" title="<?= __('editor.align_y_title') ?>" disabled><?= __('editor.align_y') ?></button>
    <button id="alignHBtn" class="palette-btn" title="<?= __('editor.align_x_title') ?>" disabled><?= __('editor.align_x') ?></button>
    <button id="distributeHBtn" class="palette-btn" title="<?= __('editor.distrib_h_title') ?>" disabled><?= __('editor.distrib_h') ?></button>
    <button id="distributeVBtn" class="palette-btn" title="<?= __('editor.distrib_v_title') ?>" disabled><?= __('editor.distrib_v') ?></button>
</div>

<div id="main">
    <aside id="sourcePanel">
        <div class="panel-header">
            <span class="panel-title"><?= __('editor.source_title') ?></span>
            <span id="parseStatus"></span>
            <button id="togglePanelBtn" title="<?= __('editor.collapse') ?>">«</button>
        </div>
        <div id="editorHost">
            <textarea id="sourceEditor" spellcheck="false"></textarea>
        </div>
    </aside>
    <div id="resizer" title="<?= __('editor.drag_resize') ?>"></div>
    <div id="canvas">
        <h1 id="diagramTitle" class="canvas-title"><?= e($diagram['title']) ?></h1>
        <button id="fitBtn" class="canvas-fit-btn" title="<?= __('editor.fit_view') ?>" aria-label="<?= __('editor.fit_view') ?>"><svg class="icon"><use href="#icon-fit"/></svg></button>
        <div id="canvasPad" class="canvas-pad">
            <button id="addNodeBtn" title="<?= __('editor.add_node_title') ?>"><svg class="icon"><use href="#icon-square-plus"/></svg></button>
            <button id="addEdgeBtn" title="<?= __('editor.add_edge_title') ?>" disabled><svg class="icon"><use href="#icon-arrow-link"/></svg></button>
            <button id="addSubgraphBtn" title="<?= __('editor.add_subgraph_title') ?>" disabled><svg class="icon"><use href="#icon-group"/></svg></button>
            <button id="moveToSubgraphBtn" title="<?= __('editor.move_title') ?>" aria-label="<?= __('editor.move_label') ?>" disabled><svg class="icon"><use href="#icon-log-in"/></svg></button>
            <button id="deleteBtn" class="danger" title="<?= __('editor.delete_title') ?>" disabled><svg class="icon"><use href="#icon-trash"/></svg></button>
        </div>
        <div id="diagram"></div>
    </div>
    <div id="resizerRight" title="<?= __('editor.drag_resize') ?>"></div>
    <aside id="notesPanel">
        <div class="panel-header">
            <button id="toggleNotesPanelBtn" title="<?= __('editor.collapse') ?>">»</button>
            <span class="panel-title"><?= __('editor.notes') ?></span>
            <span id="notesTargetLabel" class="notes-target"></span>
        </div>
        <div id="notesBody">
            <div id="notesEmpty" class="notes-empty">
                <?= __('editor.notes_empty') ?>
            </div>
            <textarea id="notesTextarea" class="hidden"
                      spellcheck="false"
                      placeholder="<?= __('editor.notes_placeholder') ?>"></textarea>
        </div>
    </aside>
</div>

<!-- Modal: new node -->
<div id="addNodeModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box">
        <h2><?= __('editor.modal.new_node.title') ?></h2>
        <label class="field">
            <span><?= __('editor.modal.new_node.id') ?><small><?= __('editor.modal.new_node.id_hint') ?></small></span>
            <input id="nodeIdInput" type="text" autocomplete="off">
        </label>
        <label class="field">
            <span><?= __('editor.modal.new_node.label') ?><small><?= __('editor.modal.new_node.label_hint') ?></small></span>
            <input id="nodeLabelInput" type="text" autocomplete="off">
        </label>
        <div class="field">
            <span><?= __('editor.modal.new_node.shape') ?></span>
            <div id="shapeGrid"></div>
        </div>
        <div id="addNodeSubgraphHint" class="modal-info hidden"></div>
        <div id="modalError"></div>
        <div class="modal-buttons">
            <button id="nodeCancelBtn"><?= __('common.cancel') ?></button>
            <button id="nodeOkBtn" class="primary"><?= __('common.create') ?></button>
        </div>
    </div>
</div>

<!-- Modal: generic confirmation (reused for all destructive confirmations) -->
<div id="confirmDialogModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box">
        <h2 id="confirmDialogTitle"><?= __('common.confirm') ?></h2>
        <div id="confirmDialogMessage" class="modal-info"></div>
        <div class="modal-buttons">
            <button id="confirmDialogCancelBtn"><?= __('common.cancel') ?></button>
            <button id="confirmDialogOkBtn" class="primary"><?= __('common.confirm') ?></button>
        </div>
    </div>
</div>

<!-- Modal: new subgraph -->
<div id="addSubgraphModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box">
        <h2><?= __('editor.modal.new_subgraph.title') ?></h2>
        <label class="field">
            <span><?= __('editor.modal.new_subgraph.id') ?><small><?= __('editor.modal.new_subgraph.id_hint') ?></small></span>
            <input id="subgraphIdInput" type="text" autocomplete="off">
        </label>
        <label class="field">
            <span><?= __('editor.modal.new_subgraph.label') ?><small><?= __('editor.modal.new_subgraph.label_hint') ?></small></span>
            <input id="subgraphTitleInput" type="text" autocomplete="off">
        </label>
        <div id="subgraphMembersInfo" class="modal-info"></div>
        <label class="field-check hidden" id="subgraphCollapsibleField">
            <input id="subgraphCollapsibleInput" type="checkbox">
            <span><?= __('editor.modal.subgraph.collapsible') ?><small><?= __('editor.modal.subgraph.collapsible_hint') ?></small></span>
        </label>
        <label class="field-check hidden" id="subgraphLockField">
            <input id="subgraphLockInput" type="checkbox">
            <span><?= __('editor.modal.subgraph.locked') ?><small><?= __('editor.modal.subgraph.locked_hint') ?></small></span>
        </label>
        <label class="field-check hidden" id="subgraphFrameLockField">
            <input id="subgraphFrameLockInput" type="checkbox">
            <span><?= __('editor.modal.subgraph.frame_locked') ?><small><?= __('editor.modal.subgraph.frame_locked_hint') ?></small></span>
        </label>
        <div id="subgraphModalError"></div>
        <div class="modal-buttons">
            <button id="subgraphCancelBtn"><?= __('common.cancel') ?></button>
            <button id="subgraphOkBtn" class="primary"><?= __('common.create') ?></button>
        </div>
    </div>
</div>

<!-- Modal: rename -->
<div id="renameModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box">
        <h2><?= __('editor.modal.rename.title') ?></h2>
        <label class="field">
            <span><?= __('editor.modal.rename.field_title') ?></span>
            <input id="renameTitleInput" type="text" autocomplete="off">
        </label>
        <div id="renameError"></div>
        <div class="modal-buttons">
            <button id="renameCancelBtn"><?= __('common.cancel') ?></button>
            <button id="renameOkBtn" class="primary"><?= __('common.save') ?></button>
        </div>
    </div>
</div>

<!-- Modal: edit edge label -->
<div id="editEdgeLabelModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box">
        <h2><?= __('editor.modal.edge_label.title') ?></h2>
        <label class="field">
            <span><?= __('editor.modal.edge_label.field') ?></span>
            <input id="editEdgeLabelInput" type="text" autocomplete="off">
        </label>
        <div class="modal-buttons">
            <button id="editEdgeLabelCancelBtn"><?= __('common.cancel') ?></button>
            <button id="editEdgeLabelOkBtn" class="primary"><?= __('common.save') ?></button>
        </div>
    </div>
</div>

<!-- Modal: palette preset editor -->
<div id="palettePresetModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box">
        <h2><?= __('editor.modal.palette.title') ?> <span id="palettePresetTitle" class="pp-title"></span></h2>
        <div class="pp-body">
            <div id="palettePresetChannels" class="pp-channels"></div>
            <div class="pp-aside">
                <div class="pp-preview-wrap">
                    <span class="pp-preview-label"><?= __('editor.modal.palette.preview') ?></span>
                    <div id="palettePresetPreview" class="pp-preview"></div>
                </div>
                <button id="palettePresetEyedrop" class="palette-btn pp-eyedrop" type="button"
                        title="<?= __('editor.modal.palette.eyedropper') ?>">
                    <svg class="icon"><use href="#icon-pipette"/></svg>
                    <span><?= __('editor.modal.palette.eyedropper') ?></span>
                </button>
            </div>
        </div>
        <div class="modal-buttons">
            <button id="palettePresetCancel"><?= __('common.cancel') ?></button>
            <button id="palettePresetOk" class="primary"><?= __('common.save') ?></button>
        </div>
    </div>
</div>

<!-- Modal: revision history -->
<div id="historyModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box modal-wide">
        <h2><?= __('editor.modal.history.title') ?></h2>
        <p class="muted-small"><?= __('editor.modal.history.help') ?></p>
        <div id="historyList" class="history-list"></div>
        <div class="modal-buttons">
            <button id="historyCloseBtn"><?= __('common.close') ?></button>
        </div>
    </div>
</div>

<!-- Modal: conflict -->
<div id="conflictModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box">
        <h2><?= __('editor.modal.conflict.title') ?></h2>
        <p><?= __('editor.modal.conflict.body1') ?></p>
        <p><strong><?= __('editor.modal.conflict.body2') ?></strong></p>
        <p><?= __('editor.modal.conflict.prompt') ?></p>
        <div class="modal-buttons modal-buttons-stack">
            <button id="conflictHistoryBtn"><?= __('editor.modal.conflict.history') ?></button>
            <button id="conflictOverwriteBtn" class="primary"><?= __('editor.modal.conflict.overwrite') ?></button>
            <button id="conflictReloadBtn" class="danger"><?= __('editor.modal.conflict.reload') ?></button>
            <button id="conflictCancelBtn"><?= __('common.cancel') ?></button>
        </div>
    </div>
</div>

<!-- Banner remote update (non-blocking) -->
<div id="remoteUpdateBanner" class="hidden"></div>

<!-- Modal: share -->
<div id="shareModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box modal-wide">
        <h2><?= __('editor.modal.share.title') ?></h2>
        <p class="muted-small"><?= __('editor.modal.share.help') ?></p>
        <form id="shareAddForm" class="share-add">
            <input id="shareEmailInput" type="email" placeholder="<?= __('editor.modal.share.placeholder') ?>" required autocomplete="off">
            <select id="sharePermInput">
                <option value="view">view</option>
                <option value="edit" selected>edit</option>
            </select>
            <button type="submit" class="primary"><?= __('dashboard.modal.share.add') ?></button>
        </form>
        <div id="shareError"></div>
        <div id="shareList" class="share-list"></div>
        <div class="modal-buttons">
            <button id="shareCloseBtn"><?= __('common.close') ?></button>
        </div>
    </div>
</div>

<!-- Banner: edit-request (in-bound, when I hold the scepter and someone wants it) -->
<div id="incomingRequestBanner" class="hidden"></div>

<!-- Merge requests: bar for a fork owner (propose merge), panel for the original owner (review) -->
<div id="mergeBar" class="hidden"></div>
<div id="incomingMergeBanner" class="hidden"></div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/mode/simple.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/edit/matchbrackets.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js"></script>
<script src="<?= e(asset('/static/editor.js')) ?>"></script>
</body>
</html>
