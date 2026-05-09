<?php /** @var array $user */
/** @var array $diagrams */
/** @var array $sharedDiagrams */
/** @var string $csrfToken */
?>
<section class="page">
    <header class="page-header">
        <h1>Dashboard</h1>
        <button id="newDiagramBtn" class="btn btn-primary">+ Nuovo diagramma</button>
    </header>

    <p class="muted">Bentornato, <strong><?= e($user['display_name'] ?? $user['email']) ?></strong>.</p>

    <h2 class="section-title">I miei diagrammi</h2>
    <?php if (empty($diagrams)): ?>
        <section class="card empty-state">
            <p>Non hai ancora diagrammi. Crea il primo per iniziare.</p>
        </section>
    <?php else: ?>
        <div class="diagram-grid">
            <?php foreach ($diagrams as $d): ?>
                <article class="diagram-card">
                    <a class="diagram-card-link" href="/editor/<?= e($d['slug']) ?>">
                        <h3><?= e($d['title'] ?: $d['slug']) ?></h3>
                        <p class="diagram-slug"><code><?= e($d['slug']) ?></code></p>
                        <p class="diagram-meta">
                            Aggiornato <?= e($d['updated_at']) ?>
                        </p>
                    </a>
                    <div class="diagram-card-actions">
                        <button class="btn-link diagram-share" data-slug="<?= e($d['slug']) ?>" data-title="<?= e($d['title']) ?>">
                            Condividi
                        </button>
                        <button class="btn-link diagram-delete" data-slug="<?= e($d['slug']) ?>" data-title="<?= e($d['title']) ?>">
                            Elimina
                        </button>
                    </div>
                </article>
            <?php endforeach; ?>
        </div>
    <?php endif; ?>

    <?php if (!empty($sharedDiagrams)): ?>
        <h2 class="section-title">Condivisi con me</h2>
        <div class="diagram-grid">
            <?php foreach ($sharedDiagrams as $d): ?>
                <article class="diagram-card diagram-card-shared">
                    <a class="diagram-card-link" href="/editor/<?= e($d['slug']) ?>">
                        <h3><?= e($d['title'] ?: $d['slug']) ?></h3>
                        <p class="diagram-slug"><code><?= e($d['slug']) ?></code></p>
                        <p class="diagram-meta">
                            <span class="share-perm-badge"><?= e($d['share_permission']) ?></span>
                            · Aggiornato <?= e($d['updated_at']) ?>
                        </p>
                    </a>
                </article>
            <?php endforeach; ?>
        </div>
    <?php endif; ?>
</section>

<!-- Modal nuovo diagramma -->
<div id="newDiagramModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box">
        <h2>Nuovo diagramma</h2>
        <label class="field">
            <span>Titolo</span>
            <input id="newDiagramTitle" type="text" autocomplete="off" placeholder="es. Architettura sistema X">
        </label>
        <label class="field">
            <span>Slug <small>(opzionale: lasciare vuoto per generarlo dal titolo)</small></span>
            <input id="newDiagramSlug" type="text" autocomplete="off" placeholder="auto-generato">
        </label>
        <div id="newDiagramError"></div>
        <div class="modal-buttons">
            <button id="newDiagramCancelBtn">Annulla</button>
            <button id="newDiagramOkBtn" class="btn btn-primary">Crea</button>
        </div>
    </div>
</div>

<!-- Modal condividi (riusato dalla dashboard) -->
<div id="dashShareModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box modal-wide">
        <h2>Condividi <span id="dashShareTitle"></span></h2>
        <p class="muted-small">L'utente deve avere un account su Aquata. "view" = sola lettura, "edit" = può modificare.</p>
        <form id="dashShareAddForm" class="share-add">
            <input id="dashShareEmailInput" type="email" placeholder="email@dominio.it" required autocomplete="off">
            <select id="dashSharePermInput">
                <option value="view">view</option>
                <option value="edit" selected>edit</option>
            </select>
            <button type="submit" class="primary">Aggiungi</button>
        </form>
        <div id="dashShareError"></div>
        <div id="dashShareList" class="share-list"></div>
        <div class="modal-buttons">
            <button id="dashShareCloseBtn">Chiudi</button>
        </div>
    </div>
</div>

<!-- Modal: conferma generica (riusa lo stile dell'editor) -->
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

<!-- Modal: info / errore (alert non bloccante) -->
<div id="infoDialogModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box">
        <h2 id="infoDialogTitle">Avviso</h2>
        <div id="infoDialogMessage" class="modal-info"></div>
        <div class="modal-buttons">
            <button id="infoDialogOkBtn" class="primary">OK</button>
        </div>
    </div>
</div>

<script src="/static/dashboard.js"></script>
