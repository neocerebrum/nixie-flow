<?php
declare(strict_types=1);

namespace App\Controllers\Api;

use App\Auth;
use App\Csrf;
use App\Json;
use App\Models\Project;
use App\RateLimit;
use App\Response;
use App\Slug;

final class ProjectController
{
    private const TITLE_MAX = 200;

    /** Auth + per-user/per-IP rate-limit. $write=true charges the write counter. */
    private function apiUser(bool $write): array
    {
        $user = Auth::requireLoginApi();
        RateLimit::throttle('api', $user, null, $write);
        return $user;
    }

    public function index(array $args): never
    {
        $user = $this->apiUser(false);
        $rows = Project::listForUser((int) $user['id']);
        Response::json(array_map(fn (array $p) => $this->toItem($p), $rows));
    }

    public function create(array $args): never
    {
        $user = $this->apiUser(true);
        Csrf::requireValidApi();
        $body = Json::readBody();

        $title = Json::requireString($body, 'title', self::TITLE_MAX, true);
        $customSlug = $body['slug'] ?? null;

        if ($customSlug === null || $customSlug === '') {
            $base = Slug::fromTitle($title);
            $slug = Slug::ensureUnique($base, [Project::class, 'slugExists']);
        } else {
            if (!is_string($customSlug) || !Slug::validate($customSlug)) {
                Response::error('Invalid slug format', 400);
            }
            if (Project::slugExists($customSlug)) {
                Response::error('Slug already exists', 409);
            }
            $slug = $customSlug;
        }

        $project = Project::create($slug, $title, (int) $user['id']);
        // Freshly created → no diagrams filed yet.
        $project['diagram_count'] = 0;
        Response::json($this->toItem($project), 201);
    }

    public function patch(array $args): never
    {
        $user = $this->apiUser(true);
        Csrf::requireValidApi();
        $project = $this->loadManageableOr404($args['slug'], $user);
        $body = Json::readBody();

        $newTitle = null;
        $newSlug = null;
        if (array_key_exists('title', $body)) {
            $newTitle = Json::requireString($body, 'title', self::TITLE_MAX, true);
        }
        if (array_key_exists('slug', $body)) {
            $candidate = $body['slug'];
            if (!is_string($candidate) || !Slug::validate($candidate)) {
                Response::error('Invalid slug format', 400);
            }
            if ($candidate !== $project['slug'] && Project::slugExists($candidate)) {
                Response::error('Slug already exists', 409);
            }
            $newSlug = $candidate;
        }
        if ($newTitle === null && $newSlug === null) {
            Response::error('Nothing to update', 400);
        }

        Project::rename((int) $project['id'], $newTitle, $newSlug);
        $fresh = Project::byId((int) $project['id']);
        Response::json($this->toItem($fresh ?? $project));
    }

    public function delete(array $args): never
    {
        $user = $this->apiUser(true);
        Csrf::requireValidApi();
        $project = $this->loadManageableOr404($args['slug'], $user);
        // Diagrams filed under it are detached (unfiled), not deleted.
        Project::softDelete((int) $project['id']);
        http_response_code(204);
        exit;
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private function loadManageableOr404(string $slug, array $user): array
    {
        $project = Project::bySlug($slug);
        if ($project === null || !empty($project['deleted_at']) || !Project::canManage($project, $user)) {
            Response::error('Not found', 404);
        }
        return $project;
    }

    private function toItem(array $p): array
    {
        return [
            'slug'          => $p['slug'],
            'title'         => $p['title'],
            'owner_id'      => (int) $p['owner_id'],
            'diagram_count' => isset($p['diagram_count']) ? (int) $p['diagram_count'] : null,
            'created_at'    => $p['created_at'],
            'updated_at'    => $p['updated_at'],
        ];
    }
}
