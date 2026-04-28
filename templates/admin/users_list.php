<?php /** @var array $users */
/** @var array $current */
/** @var string $csrfToken */
/** @var ?array $flash */
?>
<section class="page">
    <header class="page-header">
        <h1>Utenti</h1>
        <a href="/admin/users/new" class="btn btn-primary">Nuovo utente</a>
    </header>

    <?php include __DIR__ . '/../partials/flash.php'; ?>

    <table class="data">
        <thead>
        <tr>
            <th>Email</th>
            <th>Nome</th>
            <th>Ruolo</th>
            <th>Stato</th>
            <th>Ultimo login</th>
            <th>Creato</th>
            <th class="actions">Azioni</th>
        </tr>
        </thead>
        <tbody>
        <?php foreach ($users as $u): ?>
            <?php $disabled = !empty($u['disabled_at']); $isSelf = (int) $u['id'] === (int) $current['id']; ?>
            <tr class="<?= $disabled ? 'is-disabled' : '' ?>">
                <td><?= e($u['email']) ?><?php if ($isSelf): ?> <span class="badge">tu</span><?php endif; ?></td>
                <td><?= e($u['display_name'] ?? '') ?></td>
                <td><span class="badge badge-<?= e($u['role']) ?>"><?= e($u['role']) ?></span></td>
                <td><?= $disabled ? '<span class="badge badge-warn">disabilitato</span>' : '<span class="badge badge-ok">attivo</span>' ?></td>
                <td><?= e($u['last_login_at'] ?? '—') ?></td>
                <td><?= e($u['created_at'] ?? '') ?></td>
                <td class="actions">
                    <a href="/admin/users/<?= (int) $u['id'] ?>" class="btn-link">Modifica</a>
                    <?php if ($disabled): ?>
                        <form method="post" action="/admin/users/<?= (int) $u['id'] ?>/restore" class="inline-form">
                            <input type="hidden" name="_csrf" value="<?= e($csrfToken) ?>">
                            <button type="submit" class="btn-link">Riattiva</button>
                        </form>
                    <?php elseif (!$isSelf): ?>
                        <form method="post" action="/admin/users/<?= (int) $u['id'] ?>/disable" class="inline-form"
                              onsubmit="return confirm('Disabilitare <?= e($u['email']) ?>?')">
                            <input type="hidden" name="_csrf" value="<?= e($csrfToken) ?>">
                            <button type="submit" class="btn-link btn-warn">Disabilita</button>
                        </form>
                    <?php endif; ?>
                </td>
            </tr>
        <?php endforeach; ?>
        </tbody>
    </table>
</section>
