<?php /** @var ?array $flash */
if (!empty($flash) && !empty($flash['msg'])):
    $type = $flash['type'] ?? 'info';
    ?>
    <div class="flash flash-<?= e($type) ?>">
        <?= e($flash['msg']) ?>
    </div>
<?php endif; ?>
