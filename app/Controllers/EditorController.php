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

        $head = $diagram['head_revision_id']
            ? Revision::byId((int) $diagram['head_revision_id'])
            : null;

        $bootstrap = [
            'slug'        => $diagram['slug'],
            'title'       => $diagram['title'],
            'owner_id'    => (int) $diagram['owner_id'],
            'revision_id' => $head !== null ? (int) $head['id'] : null,
            'parent_id'   => $head !== null && $head['parent_id'] !== null ? (int) $head['parent_id'] : null,
            'source'      => $head !== null ? $head['source'] : '',
            'layout'      => $head !== null && $head['layout'] !== null ? json_decode($head['layout'], true) : null,
            'author_id'   => $head !== null ? (int) $head['author_id'] : null,
            'created_at'  => $diagram['created_at'],
            'updated_at'  => $diagram['updated_at'],
            'deleted_at'  => $diagram['deleted_at'] ?? null,
            'can_undo'    => $head !== null && $head['parent_id'] !== null,
            'can_redo'    => $head !== null && Revision::hasChildren((int) $diagram['id'], (int) $head['id']),
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
            'message' => 'Diagramma non trovato o non hai accesso.',
        ], ['title' => 'Non trovato — Aquata', 'active' => '']);
    }
}
