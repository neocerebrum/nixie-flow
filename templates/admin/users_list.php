<?php /** @var array $users */
/** @var array $current */
/** @var string $csrfToken */
/** @var ?array $flash */
?>
<section class="page">
    <header class="page-header">
        <h1><?= __('admin.users.heading') ?></h1>
        <a href="/admin/users/new" class="btn btn-primary"><?= __('admin.users.new') ?></a>
    </header>

    <?php include __DIR__ . '/../partials/flash.php'; ?>

    <table class="data">
        <thead>
        <tr>
            <th><?= __('admin.users.email') ?></th>
            <th><?= __('admin.users.name') ?></th>
            <th><?= __('admin.users.role') ?></th>
            <th><?= __('admin.users.tier') ?></th>
            <th><?= __('admin.users.status') ?></th>
            <th><?= __('admin.users.last_login') ?></th>
            <th><?= __('admin.users.created') ?></th>
            <th class="actions"><?= __('admin.users.actions') ?></th>
        </tr>
        </thead>
        <tbody>
        <?php foreach ($users as $u): ?>
            <?php $disabled = !empty($u['disabled_at']); $isSelf = (int) $u['id'] === (int) $current['id']; ?>
            <tr class="<?= $disabled ? 'is-disabled' : '' ?>">
                <td><?= e($u['email']) ?><?php if ($isSelf): ?> <span class="badge"><?= __('admin.users.you') ?></span><?php endif; ?></td>
                <td><?= e($u['display_name'] ?? '') ?></td>
                <td><span class="badge badge-<?= e($u['role']) ?>"><?= e($u['role']) ?></span></td>
                <td><span class="badge badge-<?= ($u['tier'] ?? 'full') === 'demo' ? 'warn' : 'ok' ?>"><?= ($u['tier'] ?? 'full') === 'demo' ? __('admin.users.tier_demo') : __('admin.users.tier_full') ?></span></td>
                <td><?= $disabled ? '<span class="badge badge-warn">' . __('admin.users.disabled') . '</span>' : '<span class="badge badge-ok">' . __('admin.users.active') . '</span>' ?></td>
                <td><?= e($u['last_login_at'] ?? '—') ?></td>
                <td><?= e($u['created_at'] ?? '') ?></td>
                <td class="actions">
                    <a href="/admin/users/<?= (int) $u['id'] ?>" class="btn-link"><?= __('admin.users.edit') ?></a>
                    <?php if (($u['tier'] ?? 'full') === 'demo' && !$disabled): ?>
                        <form method="post" action="/admin/users/<?= (int) $u['id'] ?>/promote" class="inline-form"
                              onsubmit="return confirm('<?= __('admin.users.promote_confirm', e($u['email'])) ?>')">
                            <input type="hidden" name="_csrf" value="<?= e($csrfToken) ?>">
                            <button type="submit" class="btn-link"><?= __('admin.users.promote') ?></button>
                        </form>
                    <?php endif; ?>
                    <?php if ($disabled): ?>
                        <form method="post" action="/admin/users/<?= (int) $u['id'] ?>/restore" class="inline-form">
                            <input type="hidden" name="_csrf" value="<?= e($csrfToken) ?>">
                            <button type="submit" class="btn-link"><?= __('admin.users.restore') ?></button>
                        </form>
                        <?php if ($u['role'] !== 'admin'): ?>
                        <form method="post" action="/admin/users/<?= (int) $u['id'] ?>/delete" class="inline-form"
                              onsubmit="return confirm('<?= __('admin.users.delete_confirm', e($u['email'])) ?>')">
                            <input type="hidden" name="_csrf" value="<?= e($csrfToken) ?>">
                            <button type="submit" class="btn-link btn-warn"><?= __('admin.users.delete_user') ?></button>
                        </form>
                        <?php endif; ?>
                    <?php elseif (!$isSelf): ?>
                        <form method="post" action="/admin/users/<?= (int) $u['id'] ?>/disable" class="inline-form"
                              onsubmit="return confirm('<?= __('admin.users.disable_confirm', e($u['email'])) ?>')">
                            <input type="hidden" name="_csrf" value="<?= e($csrfToken) ?>">
                            <button type="submit" class="btn-link btn-warn"><?= __('admin.users.disable') ?></button>
                        </form>
                    <?php endif; ?>
                </td>
            </tr>
        <?php endforeach; ?>
        </tbody>
    </table>
</section>
