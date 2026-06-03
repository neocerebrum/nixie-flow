<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Auth;
use App\Csrf;
use App\Models\Diagram;
use App\Models\Project;
use App\Response;
use App\View;

final class ProjectController
{
    public function show(array $args): never
    {
        $user = Auth::requireLogin();
        $project = Project::bySlug($args['slug']);
        if ($project === null || !empty($project['deleted_at']) || !Project::canAccess($project, $user)) {
            Response::notFound('Project not found');
        }

        $diagrams = Diagram::listForProject((int) $project['id']);

        View::render('project', [
            'user'       => $user,
            'project'    => $project,
            'diagrams'   => $diagrams,
            'canManage'  => Project::canManage($project, $user),
            'permission' => Project::permissionFor($project, $user),
            'csrfToken'  => Csrf::token(),
        ], [
            'title'  => ($project['title'] ?: $project['slug']) . ' — Aquata',
            'active' => 'dashboard',
        ]);
    }
}
