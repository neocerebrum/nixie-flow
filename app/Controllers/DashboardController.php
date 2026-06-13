<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Auth;
use App\Csrf;
use App\Models\Diagram;
use App\Models\Project;
use App\Models\ProjectShare;
use App\View;

final class DashboardController
{
    public function index(array $args): never
    {
        $user = Auth::requireLogin();
        $userId = (int) $user['id'];

        // Owned diagrams are now split into projects (folders) + unfiled.
        $projects = Project::listForUser($userId);
        $unfiled  = Diagram::listUnfiledForUser($userId);

        // Projects shared with this user (access cascades to their diagrams).
        $sharedProjects = ProjectShare::projectsForUser($userId);

        // Diagrams shared with this user stay a flat section (sharing is still
        // per-diagram). Reuse the accessible query and keep the non-owned rows.
        $rows = Diagram::listAccessibleForUser($userId);
        $shared = array_values(array_filter(
            $rows,
            fn (array $d) => (int) $d['owner_id'] !== $userId
        ));

        View::render('dashboard', [
            'user'           => $user,
            'projects'       => $projects,
            'diagrams'       => $unfiled,
            'sharedProjects' => $sharedProjects,
            'sharedDiagrams' => $shared,
            'csrfToken'      => Csrf::token(),
            'isDemo'         => \App\Models\User::isDemo($user),
        ], ['title' => __('dashboard.title'), 'active' => 'dashboard']);
    }
}
