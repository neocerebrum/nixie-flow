<?php /** @var array $user */
/** @var array $tokens */
/** @var string $csrfToken */
/** @var ?array $flash */
/** @var ?string $newTokenPlaintext */
/** @var string $mcpEndpoint */

use App\Models\ApiToken;
?>
<section class="page">
    <header class="page-header">
        <h1><?= __('tokens.heading') ?></h1>
        <a href="/profile" class="btn"><?= __('tokens.back') ?></a>
    </header>

    <?php include __DIR__ . '/partials/flash.php'; ?>

    <p class="muted">
        <?= __('tokens.help') ?>
    </p>

    <?php if ($newTokenPlaintext): ?>
        <section class="card token-new">
            <h2><?= __('tokens.new.heading') ?></h2>
            <p class="muted-small"><?= __('tokens.new.hint') ?></p>
            <div class="token-plaintext">
                <code id="newTokenValue"><?= e($newTokenPlaintext) ?></code>
                <button type="button" class="btn" onclick="
                    navigator.clipboard.writeText(document.getElementById('newTokenValue').textContent);
                    this.textContent='<?= __('tokens.new.copied') ?>';
                "><?= __('tokens.new.copy') ?></button>
            </div>

            <h3><?= __('tokens.new.claude.heading') ?></h3>
            <p class="muted-small"><?= __('tokens.new.claude.hint') ?></p>
            <pre class="config-snippet"><code id="claudeAddCmd">claude mcp add --scope user --transport http nixieflow <?= e($mcpEndpoint) ?> --header "Authorization: Bearer <?= e($newTokenPlaintext) ?>"</code></pre>
            <button type="button" class="btn" onclick="
                navigator.clipboard.writeText(document.getElementById('claudeAddCmd').textContent);
                this.textContent='<?= __('tokens.new.claude.copied') ?>';
            "><?= __('tokens.new.copy_cmd') ?></button>

            <h3 style="margin-top: 1rem;"><?= __('tokens.new.json.heading') ?></h3>
            <p class="muted-small"><?= __('tokens.new.json.hint') ?></p>
            <pre class="config-snippet"><code id="configSnippet">{
  "type": "http",
  "url": "<?= e($mcpEndpoint) ?>",
  "headers": {
    "Authorization": "Bearer <?= e($newTokenPlaintext) ?>"
  }
}</code></pre>
            <button type="button" class="btn" onclick="
                navigator.clipboard.writeText(document.getElementById('configSnippet').textContent);
                this.textContent='<?= __('tokens.new.json.copied') ?>';
            "><?= __('tokens.new.copy_json') ?></button>
        </section>
    <?php endif; ?>

    <section class="card">
        <h2><?= __('tokens.create.heading') ?></h2>
        <form method="post" action="/profile/tokens" class="form-inline">
            <input type="hidden" name="_csrf" value="<?= e($csrfToken) ?>">
            <input type="text" name="label" placeholder="<?= __('tokens.create.placeholder') ?>" maxlength="100">
            <button type="submit" class="btn btn-primary"><?= __('tokens.create.submit') ?></button>
        </form>
    </section>

    <section class="card">
        <h2><?= __('tokens.list.heading') ?></h2>
        <?php if (empty($tokens)): ?>
            <p class="muted"><?= __('tokens.list.empty') ?></p>
        <?php else: ?>
            <table class="token-table">
                <thead>
                    <tr>
                        <th><?= __('tokens.list.label') ?></th>
                        <th><?= __('tokens.list.fingerprint') ?></th>
                        <th><?= __('tokens.list.created') ?></th>
                        <th><?= __('tokens.list.last_used') ?></th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                <?php foreach ($tokens as $t): ?>
                    <tr>
                        <td><?= e($t['label'] ?? '—') ?></td>
                        <td><code>…<?= e(ApiToken::fingerprint($t['token_hash'])) ?></code></td>
                        <td><?= e($t['created_at']) ?></td>
                        <td><?= e($t['last_used_at'] ?? '—') ?></td>
                        <td>
                            <form method="post" action="/profile/tokens/revoke" onsubmit="return confirm('<?= __('tokens.list.revoke_confirm') ?>');">
                                <input type="hidden" name="_csrf" value="<?= e($csrfToken) ?>">
                                <input type="hidden" name="token_hash" value="<?= e($t['token_hash']) ?>">
                                <button type="submit" class="btn-link danger"><?= __('tokens.list.revoke') ?></button>
                            </form>
                        </td>
                    </tr>
                <?php endforeach; ?>
                </tbody>
            </table>
        <?php endif; ?>
    </section>

    <section class="card">
        <h2><?= __('tokens.endpoint.heading') ?></h2>
        <p><?= __('tokens.endpoint.body', e($mcpEndpoint)) ?></p>
        <p class="muted-small"><?= __('tokens.endpoint.hint') ?></p>
    </section>
</section>
