<?php
declare(strict_types=1);

namespace App\Controllers\Api;

use App\Auth;
use App\Csrf;
use App\Json;
use App\Models\Project;
use App\Models\ProjectShare;
use App\Models\User;
use App\Response;

/**
 * Project-level sharing. Granting a share on a project cascades read/edit
 * access to every diagram filed under it (see Diagram::permissionFor).
 * Mirrors ShareController; only the project owner (or an admin) may manage.
 */
final class ProjectShareController
{
    public function index(array $args): never
    {
        $user = Auth::requireLoginApi();
        $project = $this->loadManageableOr404($args['slug'], $user);

        $rows = ProjectShare::listForProject((int) $project['id']);
        Response::json([
            'shares' => array_map([$this, 'toDto'], $rows),
        ]);
    }

    public function create(array $args): never
    {
        $user = Auth::requireLoginApi();
        Csrf::requireValidApi();
        $project = $this->loadManageableOr404($args['slug'], $user);

        $body = Json::readBody();
        $email = Json::requireString($body, 'email', 200, true);
        $perm  = Json::requireString($body, 'permission', 10, true);
        if (!ProjectShare::isValidPermission($perm)) {
            Response::error("Invalid permission (use 'view' or 'edit')", 400);
        }

        $target = User::byEmail($email);
        if ($target === null) {
            Response::error('User not found', 404);
        }
        if ((int) $target['id'] === (int) $project['owner_id']) {
            Response::error('Cannot share with the owner', 400);
        }
        if (User::isDisabled($target)) {
            Response::error('User is disabled', 400);
        }

        ProjectShare::upsert((int) $project['id'], (int) $target['id'], $perm);
        $row = ProjectShare::get((int) $project['id'], (int) $target['id']);
        $row['user_email'] = $target['email'];
        $row['user_name']  = $target['display_name'];
        $row['user_disabled_at'] = $target['disabled_at'] ?? null;
        Response::json(['share' => $this->toDto($row)], 201);
    }

    public function delete(array $args): never
    {
        $user = Auth::requireLoginApi();
        Csrf::requireValidApi();
        $project = $this->loadManageableOr404($args['slug'], $user);

        $userId = (int) $args['user_id'];
        if ($userId <= 0) {
            Response::error('Invalid user id', 400);
        }
        ProjectShare::remove((int) $project['id'], $userId);
        http_response_code(204);
        exit;
    }

    /** Only owner (or admin) can manage shares. */
    private function loadManageableOr404(string $slug, array $user): array
    {
        $project = Project::bySlug($slug);
        if ($project === null || !empty($project['deleted_at']) || !Project::canManage($project, $user)) {
            Response::error('Not found', 404);
        }
        return $project;
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
