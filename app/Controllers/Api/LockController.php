<?php
declare(strict_types=1);

namespace App\Controllers\Api;

use App\Auth;
use App\Csrf;
use App\Models\Diagram;
use App\Models\Lock;
use App\Response;

final class LockController
{
    public function acquire(array $args): never
    {
        $user = Auth::requireLoginApi();
        Csrf::requireValidApi();
        $diagram = $this->loadWritableOr404($args['slug'], $user);

        $state = Lock::tryAcquire((int) $diagram['id'], (int) $user['id']);
        $acquired = $state['is_active'] && $state['user_id'] === (int) $user['id'];
        Response::json([
            'acquired' => $acquired,
            'lock'     => $state,
        ], $acquired ? 200 : 409);
    }

    public function heartbeat(array $args): never
    {
        $user = Auth::requireLoginApi();
        Csrf::requireValidApi();
        $diagram = $this->loadWritableOr404($args['slug'], $user);

        $state = Lock::heartbeat((int) $diagram['id'], (int) $user['id']);
        $held = $state['is_active'] && $state['user_id'] === (int) $user['id'];
        Response::json([
            'held' => $held,
            'lock' => $state,
        ], $held ? 200 : 410);
    }

    public function release(array $args): never
    {
        $user = Auth::requireLoginApi();
        Csrf::requireValidApi();
        $diagram = $this->loadWritableOr404($args['slug'], $user);

        $isAdmin = ($user['role'] ?? '') === 'admin';
        Lock::release((int) $diagram['id'], (int) $user['id'], $isAdmin);
        http_response_code(204);
        exit;
    }

    private function loadWritableOr404(string $slug, array $user): array
    {
        $diagram = Diagram::bySlug($slug);
        if ($diagram === null || !Diagram::canWrite($diagram, $user)) {
            Response::error('Not found', 404);
        }
        if (Diagram::isDeleted($diagram) && ($user['role'] ?? '') !== 'admin') {
            Response::error('Not found', 404);
        }
        return $diagram;
    }
}
