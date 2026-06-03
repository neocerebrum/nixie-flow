<?php
/**
 * One diagram card for a diagram owned by the current user.
 * Expects $d (a diagram row: slug, title, updated_at).
 * @var array $d
 */
?>
<article class="diagram-card">
    <a class="diagram-card-link" href="/editor/<?= e($d['slug']) ?>">
        <h3><?= e($d['title'] ?: $d['slug']) ?></h3>
        <p class="diagram-slug"><code><?= e($d['slug']) ?></code></p>
        <p class="diagram-meta"><?= __('dashboard.updated', e($d['updated_at'])) ?></p>
    </a>
    <div class="diagram-card-actions">
        <button class="btn-icon diagram-share" data-slug="<?= e($d['slug']) ?>" data-title="<?= e($d['title']) ?>" title="<?= __('dashboard.share') ?>" aria-label="<?= __('dashboard.share') ?>">
            <svg class="icon"><use href="#icon-share"/></svg>
        </button>
        <button class="btn-icon diagram-move" data-slug="<?= e($d['slug']) ?>" data-title="<?= e($d['title']) ?>" title="<?= __('dashboard.move') ?>" aria-label="<?= __('dashboard.move') ?>">
            <svg class="icon"><use href="#icon-folder-input"/></svg>
        </button>
        <button class="btn-icon diagram-duplicate" data-slug="<?= e($d['slug']) ?>" data-title="<?= e($d['title']) ?>" title="<?= __('dashboard.duplicate') ?>" aria-label="<?= __('dashboard.duplicate') ?>">
            <svg class="icon"><use href="#icon-copy"/></svg>
        </button>
        <button class="btn-icon diagram-rename" data-slug="<?= e($d['slug']) ?>" data-title="<?= e($d['title']) ?>" title="<?= __('dashboard.rename') ?>" aria-label="<?= __('dashboard.rename') ?>">
            <svg class="icon"><use href="#icon-rename"/></svg>
        </button>
        <button class="btn-icon danger diagram-delete" data-slug="<?= e($d['slug']) ?>" data-title="<?= e($d['title']) ?>" title="<?= __('dashboard.delete') ?>" aria-label="<?= __('dashboard.delete') ?>">
            <svg class="icon"><use href="#icon-trash"/></svg>
        </button>
    </div>
</article>
