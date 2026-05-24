<?php /** @var array $user */
/** @var array $diagrams */
/** @var array $sharedDiagrams */
/** @var string $csrfToken */
?>
<section class="page">
    <header class="page-header">
        <h1><?= __('dashboard.heading') ?></h1>
        <button id="newDiagramBtn" class="btn btn-primary"><svg class="icon icon-sm"><use href="#icon-plus"/></svg> <?= __('dashboard.new_diagram') ?></button>
    </header>

    <p class="muted"><?= __('dashboard.welcome', e($user['display_name'] ?? $user['email'])) ?></p>

    <h2 class="section-title"><?= __('dashboard.my_diagrams') ?></h2>
    <?php if (empty($diagrams)): ?>
        <section class="card empty-state">
            <p><?= __('dashboard.empty') ?></p>
        </section>
    <?php else: ?>
        <div class="diagram-grid">
            <?php foreach ($diagrams as $d): ?>
                <article class="diagram-card">
                    <a class="diagram-card-link" href="/editor/<?= e($d['slug']) ?>">
                        <h3><?= e($d['title'] ?: $d['slug']) ?></h3>
                        <p class="diagram-slug"><code><?= e($d['slug']) ?></code></p>
                        <p class="diagram-meta">
                            <?= __('dashboard.updated', e($d['updated_at'])) ?>
                        </p>
                    </a>
                    <div class="diagram-card-actions">
                        <button class="btn-icon diagram-share" data-slug="<?= e($d['slug']) ?>" data-title="<?= e($d['title']) ?>" title="<?= __('dashboard.share') ?>" aria-label="<?= __('dashboard.share') ?>">
                            <svg class="icon"><use href="#icon-share"/></svg>
                        </button>
                        <button class="btn-icon diagram-rename" data-slug="<?= e($d['slug']) ?>" data-title="<?= e($d['title']) ?>" title="<?= __('dashboard.rename') ?>" aria-label="<?= __('dashboard.rename') ?>">
                            <svg class="icon"><use href="#icon-rename"/></svg>
                        </button>
                        <button class="btn-icon danger diagram-delete" data-slug="<?= e($d['slug']) ?>" data-title="<?= e($d['title']) ?>" title="<?= __('dashboard.delete') ?>" aria-label="<?= __('dashboard.delete') ?>">
                            <svg class="icon"><use href="#icon-trash"/></svg>
                        </button>
                    </div>
                </article>
            <?php endforeach; ?>
        </div>
    <?php endif; ?>

    <?php if (!empty($sharedDiagrams)): ?>
        <h2 class="section-title"><?= __('dashboard.shared_with_me') ?></h2>
        <div class="diagram-grid">
            <?php foreach ($sharedDiagrams as $d): ?>
                <article class="diagram-card diagram-card-shared">
                    <a class="diagram-card-link" href="/editor/<?= e($d['slug']) ?>">
                        <h3><?= e($d['title'] ?: $d['slug']) ?></h3>
                        <p class="diagram-slug"><code><?= e($d['slug']) ?></code></p>
                        <p class="diagram-meta">
                            <span class="share-perm-badge"><?= e($d['share_permission']) ?></span>
                            · <?= __('dashboard.updated', e($d['updated_at'])) ?>
                        </p>
                    </a>
                </article>
            <?php endforeach; ?>
        </div>
    <?php endif; ?>
</section>

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

<!-- Modal: rename -->
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

<!-- Modal: share (reused from dashboard) -->
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

<!-- Modal: generic confirmation (reuses editor styling) -->
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

<script src="/static/dashboard.js"></script>
