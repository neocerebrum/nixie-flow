<?php /** @var string $message */ ?>
<section class="page">
    <h1>404 — Non trovato</h1>
    <p><?= e($message ?? 'La risorsa richiesta non esiste o non hai i permessi per accedervi.') ?></p>
    <p><a href="/dashboard" class="btn">← Torna alla dashboard</a></p>
</section>
