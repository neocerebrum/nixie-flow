<?php
/**
 * Shared modal dialogs for the dashboard and project pages. Driven by
 * static/dashboard.js. Included once per page (after the page content).
 */
?>
<!-- Modal: new diagram -->
<div id="newDiagramModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box">
        <h2><?= __('dashboard.modal.new.title') ?></h2>
        <label class="field">
            <span><?= __('dashboard.modal.new.field_title') ?></span>
            <input id="newDiagramTitle" type="text" autocomplete="off" placeholder="<?= __('dashboard.modal.new.placeholder') ?>">
        </label>
        <label class="field">
            <span><?= __('dashboard.modal.new.field_slug') ?></span>
            <input id="newDiagramSlug" type="text" autocomplete="off" placeholder="<?= __('dashboard.modal.new.slug_placeholder') ?>">
        </label>
        <div id="newDiagramError"></div>
        <div class="modal-buttons">
            <button id="newDiagramCancelBtn"><?= __('common.cancel') ?></button>
            <button id="newDiagramOkBtn" class="btn btn-primary"><?= __('dashboard.modal.new.create') ?></button>
        </div>
    </div>
</div>

<!-- Modal: new project -->
<div id="newProjectModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box">
        <h2><?= __('dashboard.modal.new_project.title') ?></h2>
        <label class="field">
            <span><?= __('dashboard.modal.new_project.field_title') ?></span>
            <input id="newProjectTitle" type="text" autocomplete="off" placeholder="<?= __('dashboard.modal.new_project.placeholder') ?>">
        </label>
        <label class="field">
            <span><?= __('dashboard.modal.new.field_slug') ?></span>
            <input id="newProjectSlug" type="text" autocomplete="off" placeholder="<?= __('dashboard.modal.new.slug_placeholder') ?>">
        </label>
        <div id="newProjectError"></div>
        <div class="modal-buttons">
            <button id="newProjectCancelBtn"><?= __('common.cancel') ?></button>
            <button id="newProjectOkBtn" class="btn btn-primary"><?= __('dashboard.modal.new_project.create') ?></button>
        </div>
    </div>
</div>

<!-- Modal: rename diagram -->
<div id="renameDiagramModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box">
        <h2><?= __('dashboard.modal.rename.title') ?></h2>
        <label class="field">
            <span><?= __('dashboard.modal.rename.field_title') ?></span>
            <input id="renameDiagramTitle" type="text" autocomplete="off">
        </label>
        <div id="renameDiagramError"></div>
        <div class="modal-buttons">
            <button id="renameDiagramCancelBtn"><?= __('common.cancel') ?></button>
            <button id="renameDiagramOkBtn" class="btn btn-primary"><?= __('dashboard.modal.rename.save') ?></button>
        </div>
    </div>
</div>

<!-- Modal: rename project -->
<div id="renameProjectModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box">
        <h2><?= __('dashboard.modal.rename_project.title') ?></h2>
        <label class="field">
            <span><?= __('dashboard.modal.rename.field_title') ?></span>
            <input id="renameProjectTitle" type="text" autocomplete="off">
        </label>
        <div id="renameProjectError"></div>
        <div class="modal-buttons">
            <button id="renameProjectCancelBtn"><?= __('common.cancel') ?></button>
            <button id="renameProjectOkBtn" class="btn btn-primary"><?= __('dashboard.modal.rename.save') ?></button>
        </div>
    </div>
</div>

<!-- Modal: move diagram into a project -->
<div id="moveDiagramModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box">
        <h2><?= __('dashboard.modal.move.title') ?> <span id="moveDiagramTitle"></span></h2>
        <label class="field">
            <span><?= __('dashboard.modal.move.field_project') ?></span>
            <select id="moveProjectSelect"></select>
        </label>
        <div id="moveDiagramError"></div>
        <div class="modal-buttons">
            <button id="moveDiagramCancelBtn"><?= __('common.cancel') ?></button>
            <button id="moveDiagramOkBtn" class="btn btn-primary"><?= __('dashboard.modal.move.save') ?></button>
        </div>
    </div>
</div>

<!-- Modal: share -->
<div id="dashShareModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box modal-wide">
        <h2><?= __('dashboard.modal.share.title') ?> <span id="dashShareTitle"></span></h2>
        <p class="muted-small"><?= __('dashboard.modal.share.help') ?></p>
        <form id="dashShareAddForm" class="share-add">
            <input id="dashShareEmailInput" type="email" placeholder="<?= __('dashboard.modal.share.placeholder') ?>" required autocomplete="off">
            <select id="dashSharePermInput">
                <option value="view">view</option>
                <option value="edit" selected>edit</option>
            </select>
            <button type="submit" class="primary"><?= __('dashboard.modal.share.add') ?></button>
        </form>
        <div id="dashShareError"></div>
        <div id="dashShareList" class="share-list"></div>
        <div class="modal-buttons">
            <button id="dashShareCloseBtn"><?= __('dashboard.modal.share.close') ?></button>
        </div>
    </div>
</div>

<!-- Modal: share project (cascades to all its diagrams) -->
<div id="projShareModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box modal-wide">
        <h2><?= __('dashboard.modal.share_project.title') ?> <span id="projShareTitle"></span></h2>
        <p class="muted-small"><?= __('dashboard.modal.share_project.help') ?></p>
        <form id="projShareAddForm" class="share-add">
            <input id="projShareEmailInput" type="email" placeholder="<?= __('dashboard.modal.share.placeholder') ?>" required autocomplete="off">
            <select id="projSharePermInput">
                <option value="view">view</option>
                <option value="edit" selected>edit</option>
            </select>
            <button type="submit" class="primary"><?= __('dashboard.modal.share.add') ?></button>
        </form>
        <div id="projShareError"></div>
        <div id="projShareList" class="share-list"></div>
        <div class="modal-buttons">
            <button id="projShareCloseBtn"><?= __('dashboard.modal.share.close') ?></button>
        </div>
    </div>
</div>

<!-- Modal: generic confirmation -->
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

<!-- Modal: info / error (non-blocking alert) -->
<div id="infoDialogModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box">
        <h2 id="infoDialogTitle"><?= __('common.alert') ?></h2>
        <div id="infoDialogMessage" class="modal-info"></div>
        <div class="modal-buttons">
            <button id="infoDialogOkBtn" class="primary"><?= __('common.ok') ?></button>
        </div>
    </div>
</div>
