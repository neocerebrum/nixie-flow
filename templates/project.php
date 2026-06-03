<?php /** @var array $user */
/** @var array $project */
/** @var array $diagrams */
/** @var string $csrfToken */
?>
<section class="page page-dashboard" data-project="<?= e($project['slug']) ?>">
    <nav class="breadcrumb">
        <a href="/dashboard"><?= __('nav.dashboard') ?></a>
        <span class="breadcrumb-sep">/</span>
        <span class="breadcrumb-current"><?= e($project['title'] ?: $project['slug']) ?></span>
    </nav>

    <header class="page-header">
        <h1 class="project-heading"><svg class="icon icon-lg"><use href="#icon-folder"/></svg> <?= e($project['title'] ?: $project['slug']) ?></h1>
        <div class="page-header-actions">
            <button id="renameProjectHeaderBtn" class="btn" data-slug="<?= e($project['slug']) ?>" data-title="<?= e($project['title']) ?>"><svg class="icon icon-sm"><use href="#icon-rename"/></svg> <?= __('dashboard.rename') ?></button>
            <button id="newDiagramBtn" class="btn btn-primary"><svg class="icon icon-sm"><use href="#icon-plus"/></svg> <?= __('dashboard.new_diagram') ?></button>
        </div>
    </header>

    <?php if (empty($diagrams)): ?>
        <section class="card empty-state">
            <p><?= __('project.empty') ?></p>
        </section>
    <?php else: ?>
        <div class="diagram-grid">
            <?php foreach ($diagrams as $d): include __DIR__ . '/partials/diagram_card.php'; endforeach; ?>
        </div>
    <?php endif; ?>
</section>

<?php include __DIR__ . '/partials/diagram_modals.php'; ?>

<script>window.__projectSlug = <?= json_encode($project['slug'], JSON_UNESCAPED_UNICODE | JSON_HEX_TAG) ?>;</script>
<script src="/static/dashboard.js"></script>
