<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Auth;
use App\Models\Diagram;
use App\Models\Lock;
use App\Models\MergeRequest;
use App\Models\Project;
use App\Models\Revision;
use App\Response;
use App\View;

final class EditorController
{
    public function show(array $args): never
    {
        $user = Auth::requireLogin();
        $slug = (string) ($args['slug'] ?? '');

        $diagram = Diagram::bySlug($slug);
        if ($diagram === null || !Diagram::canAccess($diagram, $user)) {
            $this->render404();
        }

        $isAdmin = ($user['role'] ?? '') === 'admin';
        if (Diagram::isDeleted($diagram) && !$isAdmin) {
            $this->render404();
        }
        if (Diagram::isExpired($diagram) && !$isAdmin) {
            $_SESSION['_flash'] = ['type' => 'warn', 'msg' => __('demo.diagram_expired')];
            Response::redirect('/dashboard');
        }

        $current = Revision::current((int) $diagram['id']);
        $sourceRevId = $current !== null && $current['source_revision_id'] !== null
            ? (int) $current['source_revision_id'] : null;

        $bootstrap = [
            'slug'        => $diagram['slug'],
            'title'       => $diagram['title'],
            'owner_id'    => (int) $diagram['owner_id'],
            'revision_id' => $sourceRevId,
            'parent_id'   => null,
            'source'      => $current !== null ? $current['source'] : '',
            'layout'      => $current !== null && $current['layout'] !== null ? json_decode($current['layout'], true) : null,
            'author_id'   => $current !== null ? (int) $current['author_id'] : null,
            'created_at'  => $diagram['created_at'],
            'updated_at'  => $diagram['updated_at'],
            'deleted_at'  => $diagram['deleted_at'] ?? null,
            'expires_at'  => $diagram['expires_at'] ?? null,
            'can_undo'    => false,
            'can_redo'    => false,
            'permission'  => Diagram::permissionFor($diagram, $user),
            'me'          => [
                'id'           => (int) $user['id'],
                'email'        => $user['email'] ?? null,
                'display_name' => $user['display_name'] ?? null,
            ],
            'lock'        => Lock::state($diagram),
            'merge'       => $this->mergeContext($diagram, $user),
            'back'        => $this->backLink($diagram, $user),
        ];

        // Editor is a full-page application: render WITHOUT the standard layout
        // wrapper, since editor.php provides its own <html>/<head>/<body>.
        View::renderRaw('editor', [
            'diagram'   => $diagram,
            'bootstrap' => $bootstrap,
        ]);
    }

    /**
     * Where the editor's "exit" button returns to: the diagram's project page
     * when it is filed under a project the user can still access, otherwise the
     * dashboard. Without this, a diagram opened from inside a project sends the
     * user back to the dashboard root instead of the project they came from.
     */
    private function backLink(array $diagram, array $user): string
    {
        if (!empty($diagram['project_id'])) {
            $project = Project::byId((int) $diagram['project_id']);
            if ($project !== null && empty($project['deleted_at']) && Project::canAccess($project, $user)) {
                return '/project/' . rawurlencode((string) $project['slug']);
            }
        }
        return '/dashboard';
    }

    /**
     * Merge-request context for the editor: whether this diagram is a fork that
     * can request a merge onto its origin (+ my pending request), and whether I
     * manage it as a merge target (+ how many requests are pending on it).
     * @return array<string, mixed>
     */
    private function mergeContext(array $diagram, array $user): array
    {
        $me = (int) $user['id'];
        $origin = null;
        $canRequest = false;
        $pending = null;

        if (!empty($diagram['source_diagram_id'])) {
            $orig = Diagram::byId((int) $diagram['source_diagram_id']);
            if ($orig !== null && !Diagram::isDeleted($orig)) {
                $origin = ['slug' => $orig['slug'], 'title' => $orig['title']];
                if ((int) $diagram['owner_id'] === $me && (int) $orig['owner_id'] !== $me) {
                    $canRequest = true;
                    $p = MergeRequest::mineForSource((int) $diagram['id'], $me);
                    if ($p !== null && ($p['status'] ?? '') === 'pending') {
                        $pending = ['id' => (int) $p['id'], 'status' => $p['status'], 'note' => $p['note'] ?? null];
                    }
                }
            }
        }

        $manage = (int) $diagram['owner_id'] === $me;

        return [
            'origin'      => $origin,
            'can_request' => $canRequest,
            'pending'     => $pending,
            'manage'      => $manage,
            'incoming'    => $manage ? MergeRequest::countPendingForTarget((int) $diagram['id']) : 0,
        ];
    }

    private function render404(): never
    {
        http_response_code(404);
        View::render('404', [
            'message' => __('error.diagram_not_found'),
        ], ['title' => __('404.title'), 'active' => '']);
    }
}
