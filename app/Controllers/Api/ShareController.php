<?php
declare(strict_types=1);

namespace App\Controllers\Api;

use App\Auth;
use App\Csrf;
use App\Json;
use App\Models\Diagram;
use App\Models\Share;
use App\Models\User;
use App\Response;

final class ShareController
{
    public function index(array $args): never
    {
        $user = Auth::requireLoginApi();
        $diagram = $this->loadOwnedOr404($args['slug'], $user);

        $rows = Share::listForDiagram((int) $diagram['id']);
        Response::json([
            'shares' => array_map([$this, 'toDto'], $rows),
        ]);
    }

    public function create(array $args): never
    {
        $user = Auth::requireLoginApi();
        Csrf::requireValidApi();
        $diagram = $this->loadOwnedOr404($args['slug'], $user);

        $body = Json::readBody();
        $email = Json::requireString($body, 'email', 200, true);
        $perm  = Json::requireString($body, 'permission', 10, true);
        if (!Share::isValidPermission($perm)) {
            Response::error("Invalid permission (use 'view' or 'edit')", 400);
        }

        $target = User::byEmail($email);
        if ($target === null) {
            Response::error('User not found', 404);
        }
        if ((int) $target['id'] === (int) $diagram['owner_id']) {
            Response::error('Cannot share with the owner', 400);
        }
        if (User::isDisabled($target)) {
            Response::error('User is disabled', 400);
        }

        Share::upsert((int) $diagram['id'], (int) $target['id'], $perm);
        $row = Share::get((int) $diagram['id'], (int) $target['id']);
        // augment with user info for DTO
        $row['user_email'] = $target['email'];
        $row['user_name']  = $target['display_name'];
        $row['user_disabled_at'] = $target['disabled_at'] ?? null;
        Response::json(['share' => $this->toDto($row)], 201);
    }

    public function delete(array $args): never
    {
        $user = Auth::requireLoginApi();
        Csrf::requireValidApi();
        $diagram = $this->loadOwnedOr404($args['slug'], $user);

        $userId = (int) $args['user_id'];
        if ($userId <= 0) {
            Response::error('Invalid user id', 400);
        }
        Share::remove((int) $diagram['id'], $userId);
        http_response_code(204);
        exit;
    }

    /** Only owner (or admin) can manage shares. */
    private function loadOwnedOr404(string $slug, array $user): array
    {
        $diagram = Diagram::bySlug($slug);
        if ($diagram === null) {
            Response::error('Not found', 404);
        }
        // Managing a diagram's shares is owner-only; admins are not elevated.
        if ((int) $diagram['owner_id'] !== (int) $user['id']) {
            Response::error('Not found', 404);
        }
        if (Diagram::isDeleted($diagram)) {
            Response::error('Not found', 404);
        }
        return $diagram;
    }

    private function toDto(array $r): array
    {
        return [
            'user_id'    => (int) $r['user_id'],
            'user_email' => $r['user_email'] ?? null,
            'user_name'  => $r['user_name'] ?? null,
            'permission' => $r['permission'],
            'shared_at'  => $r['shared_at'] ?? null,
            'disabled'   => !empty($r['user_disabled_at']),
        ];
    }
}
