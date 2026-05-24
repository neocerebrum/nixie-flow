<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Auth;
use App\Models\Diagram;
use App\Models\Lock;
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
            'can_undo'    => false,
            'can_redo'    => false,
            'permission'  => Diagram::permissionFor($diagram, $user),
            'me'          => [
                'id'           => (int) $user['id'],
                'email'        => $user['email'] ?? null,
                'display_name' => $user['display_name'] ?? null,
            ],
            'lock'        => Lock::state($diagram),
        ];

        // Editor is a full-page application: render WITHOUT the standard layout
        // wrapper, since editor.php provides its own <html>/<head>/<body>.
        View::renderRaw('editor', [
            'diagram'   => $diagram,
            'bootstrap' => $bootstrap,
        ]);
    }

    private function render404(): never
    {
        http_response_code(404);
        View::render('404', [
            'message' => __('error.diagram_not_found'),
        ], ['title' => __('404.title'), 'active' => '']);
    }
}
