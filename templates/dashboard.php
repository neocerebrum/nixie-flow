<?php /** @var array $user */
/** @var array $projects */
/** @var array $diagrams */       // unfiled diagrams owned by the user
/** @var array $sharedProjects */
/** @var array $sharedDiagrams */
/** @var string $csrfToken */
?>
<section class="page page-dashboard">
    <header class="page-header">
        <h1><?= __('dashboard.heading') ?></h1>
        <div class="page-header-actions">
            <button id="newProjectBtn" class="btn"><svg class="icon icon-sm"><use href="#icon-folder-plus"/></svg> <?= __('dashboard.new_project') ?></button>
            <button id="newDiagramBtn" class="btn btn-primary"><svg class="icon icon-sm"><use href="#icon-plus"/></svg> <?= __('dashboard.new_diagram') ?></button>
        </div>
    </header>

    <p class="muted"><?= __('dashboard.welcome', e($user['display_name'] ?? $user['email'])) ?></p>

    <h2 class="section-title"><?= __('dashboard.projects') ?></h2>
    <?php if (empty($projects)): ?>
        <p class="muted-small section-empty"><?= __('dashboard.projects_empty') ?></p>
    <?php else: ?>
        <div class="project-grid">
            <?php foreach ($projects as $p): ?>
                <article class="project-card">
                    <a class="project-card-link" href="/project/<?= e($p['slug']) ?>">
                        <span class="project-folder"><svg class="icon icon-lg"><use href="#icon-folder"/></svg></span>
                        <span class="project-body">
                            <span class="project-name"><?= e($p['title'] ?: $p['slug']) ?></span>
                            <span class="project-count"><?= __('dashboard.project_count', (int) $p['diagram_count']) ?></span>
                        </span>
                    </a>
                    <div class="diagram-card-actions">
                        <button class="btn-icon project-share" data-slug="<?= e($p['slug']) ?>" data-title="<?= e($p['title']) ?>" title="<?= __('dashboard.share_project') ?>" aria-label="<?= __('dashboard.share_project') ?>">
                            <svg class="icon"><use href="#icon-share"/></svg>
                        </button>
                        <button class="btn-icon project-rename" data-slug="<?= e($p['slug']) ?>" data-title="<?= e($p['title']) ?>" title="<?= __('dashboard.rename') ?>" aria-label="<?= __('dashboard.rename') ?>">
                            <svg class="icon"><use href="#icon-rename"/></svg>
                        </button>
                        <button class="btn-icon danger project-delete" data-slug="<?= e($p['slug']) ?>" data-title="<?= e($p['title']) ?>" title="<?= __('dashboard.delete') ?>" aria-label="<?= __('dashboard.delete') ?>">
                            <svg class="icon"><use href="#icon-trash"/></svg>
                        </button>
                    </div>
                </article>
            <?php endforeach; ?>
        </div>
    <?php endif; ?>

    <h2 class="section-title"><?= __('dashboard.my_diagrams') ?></h2>
    <?php if (empty($diagrams)): ?>
        <p class="muted-small section-empty"><?= empty($projects) ? __('dashboard.empty') : __('dashboard.unfiled_empty') ?></p>
    <?php else: ?>
        <div class="diagram-grid">
            <?php foreach ($diagrams as $d): include __DIR__ . '/partials/diagram_card.php'; endforeach; ?>
        </div>
    <?php endif; ?>

    <?php if (!empty($sharedProjects)): ?>
        <h2 class="section-title"><?= __('dashboard.shared_projects') ?></h2>
        <div class="project-grid">
            <?php foreach ($sharedProjects as $p): ?>
                <article class="project-card project-card-shared">
                    <a class="project-card-link" href="/project/<?= e($p['slug']) ?>">
                        <span class="project-folder"><svg class="icon icon-lg"><use href="#icon-folder"/></svg></span>
                        <span class="project-body">
                            <span class="project-name"><?= e($p['title'] ?: $p['slug']) ?></span>
                            <span class="project-count">
                                <span class="share-perm-badge"><?= e($p['share_permission']) ?></span>
                                · <?= __('dashboard.project_count', (int) $p['diagram_count']) ?>
                            </span>
                        </span>
                    </a>
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
                    <div class="diagram-card-actions">
                        <button class="btn-icon diagram-duplicate" data-slug="<?= e($d['slug']) ?>" data-title="<?= e($d['title']) ?>" title="<?= __('dashboard.duplicate') ?>" aria-label="<?= __('dashboard.duplicate') ?>">
                            <svg class="icon"><use href="#icon-copy"/></svg>
                        </button>
                    </div>
                </article>
            <?php endforeach; ?>
        </div>
    <?php endif; ?>
</section>

<?php include __DIR__ . '/partials/diagram_modals.php'; ?>

<script src="<?= e(asset('/static/dashboard.js')) ?>"></script>
