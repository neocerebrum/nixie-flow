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
        <h1>Token API</h1>
        <a href="/profile" class="btn">← Profilo</a>
    </header>

    <?php include __DIR__ . '/partials/flash.php'; ?>

    <p class="muted">
        I token Bearer servono a Claude (via MCP) e ad altri client API per agire come te su Aquata.
        Una volta creato, il token non può più essere recuperato — copialo subito e conservalo in un password manager.
    </p>

    <?php if ($newTokenPlaintext): ?>
        <section class="card token-new">
            <h2>Token appena creato</h2>
            <p class="muted-small">Mostrato una volta sola. Da ora in DB c'è solo l'hash sha256.</p>
            <div class="token-plaintext">
                <code id="newTokenValue"><?= e($newTokenPlaintext) ?></code>
                <button type="button" class="btn" onclick="
                    navigator.clipboard.writeText(document.getElementById('newTokenValue').textContent);
                    this.textContent='Copiato ✓';
                ">Copia</button>
            </div>

            <h3>Aggiungi a Claude Code</h3>
            <p class="muted-small">Esegui questo comando in qualsiasi terminale (lo registra a livello utente):</p>
            <pre class="config-snippet"><code id="claudeAddCmd">claude mcp add --scope user --transport http aquata <?= e($mcpEndpoint) ?> --header "Authorization: Bearer <?= e($newTokenPlaintext) ?>"</code></pre>
            <button type="button" class="btn" onclick="
                navigator.clipboard.writeText(document.getElementById('claudeAddCmd').textContent);
                this.textContent='Comando copiato ✓';
            ">Copia comando</button>

            <h3 style="margin-top: 1rem;">Oppure: JSON grezzo</h3>
            <p class="muted-small">Se preferisci editare un file di config (project-scope <code>.mcp.json</code> o user-scope tramite <code>claude mcp add-json</code>):</p>
            <pre class="config-snippet"><code id="configSnippet">{
  "type": "http",
  "url": "<?= e($mcpEndpoint) ?>",
  "headers": {
    "Authorization": "Bearer <?= e($newTokenPlaintext) ?>"
  }
}</code></pre>
            <button type="button" class="btn" onclick="
                navigator.clipboard.writeText(document.getElementById('configSnippet').textContent);
                this.textContent='JSON copiato ✓';
            ">Copia JSON</button>
        </section>
    <?php endif; ?>

    <section class="card">
        <h2>Crea nuovo token</h2>
        <form method="post" action="/profile/tokens" class="form-inline">
            <input type="hidden" name="_csrf" value="<?= e($csrfToken) ?>">
            <input type="text" name="label" placeholder="Etichetta (es. 'laptop di casa')" maxlength="100">
            <button type="submit" class="btn btn-primary">+ Crea token</button>
        </form>
    </section>

    <section class="card">
        <h2>I tuoi token</h2>
        <?php if (empty($tokens)): ?>
            <p class="muted">Nessun token. Creane uno qui sopra.</p>
        <?php else: ?>
            <table class="token-table">
                <thead>
                    <tr>
                        <th>Etichetta</th>
                        <th>Fingerprint</th>
                        <th>Creato</th>
                        <th>Ultimo uso</th>
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
                            <form method="post" action="/profile/tokens/revoke" onsubmit="return confirm('Revocare definitivamente questo token?');">
                                <input type="hidden" name="_csrf" value="<?= e($csrfToken) ?>">
                                <input type="hidden" name="token_hash" value="<?= e($t['token_hash']) ?>">
                                <button type="submit" class="btn-link danger">Revoca</button>
                            </form>
                        </td>
                    </tr>
                <?php endforeach; ?>
                </tbody>
            </table>
        <?php endif; ?>
    </section>

    <section class="card">
        <h2>Endpoint MCP</h2>
        <p>L'endpoint HTTP è <code><?= e($mcpEndpoint) ?></code>.</p>
        <p class="muted-small">Tutte le richieste richiedono header <code>Authorization: Bearer aqt_...</code>. Il transport è MCP Streamable HTTP (JSON-RPC 2.0).</p>
    </section>
</section>
