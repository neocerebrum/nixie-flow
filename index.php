<?php
declare(strict_types=1);

require __DIR__ . '/app/bootstrap.php';

$router = new App\Router();

// Public
$router->get('/',         [App\Controllers\HomeController::class,    'index']);
$router->get('/login',    [App\Controllers\AuthController::class,    'loginForm']);
$router->post('/login',   [App\Controllers\AuthController::class,    'login']);
$router->post('/logout',  [App\Controllers\AuthController::class,    'logout']);

// Self-service signup
$router->get('/signup',                 [App\Controllers\SignupController::class, 'showForm']);
$router->post('/signup',                [App\Controllers\SignupController::class, 'submit']);
$router->get('/signup/check-email',     [App\Controllers\SignupController::class, 'checkEmail']);
$router->get('/signup/verify',          [App\Controllers\SignupController::class, 'showVerify']);
$router->post('/signup/verify',         [App\Controllers\SignupController::class, 'doVerify']);
$router->post('/signup/resend',         [App\Controllers\SignupController::class, 'resend']);

// Password reset (web)
$router->get('/password-reset',          [App\Controllers\PasswordResetController::class, 'requestForm']);
$router->post('/password-reset',         [App\Controllers\PasswordResetController::class, 'requestSubmit']);
$router->get('/password-reset/confirm',  [App\Controllers\PasswordResetController::class, 'confirmForm']);
$router->post('/password-reset/confirm', [App\Controllers\PasswordResetController::class, 'confirmSubmit']);

// Authenticated user
$router->get('/dashboard',      [App\Controllers\DashboardController::class, 'index']);
$router->get('/project/{slug}', [App\Controllers\ProjectController::class,   'show']);
$router->get('/editor/{slug}',  [App\Controllers\EditorController::class,    'show']);
$router->get('/profile',                  [App\Controllers\ProfileController::class, 'show']);
$router->post('/profile',                 [App\Controllers\ProfileController::class, 'save']);
$router->get('/profile/tokens',           [App\Controllers\ProfileController::class, 'tokens']);
$router->post('/profile/tokens',          [App\Controllers\ProfileController::class, 'createToken']);
$router->post('/profile/tokens/revoke',   [App\Controllers\ProfileController::class, 'revokeToken']);

// Admin
$router->get('/admin/users',           [App\Controllers\Admin\UserController::class, 'index']);
$router->get('/admin/users/new',       [App\Controllers\Admin\UserController::class, 'newForm']);
$router->post('/admin/users',          [App\Controllers\Admin\UserController::class, 'create']);
$router->get('/admin/users/{id}',      [App\Controllers\Admin\UserController::class, 'editForm']);
$router->post('/admin/users/{id}',     [App\Controllers\Admin\UserController::class, 'update']);
$router->post('/admin/users/{id}/disable', [App\Controllers\Admin\UserController::class, 'disable']);
$router->post('/admin/users/{id}/restore', [App\Controllers\Admin\UserController::class, 'restore']);
$router->post('/admin/users/{id}/promote', [App\Controllers\Admin\UserController::class, 'promote']);
$router->post('/admin/users/{id}/delete',  [App\Controllers\Admin\UserController::class, 'deleteUser']);

// API
$router->get('/api/csrf',                       [App\Controllers\Api\CsrfController::class,    'token']);
$router->get('/api/diagrams',                   [App\Controllers\Api\DiagramController::class, 'index']);
$router->post('/api/diagrams',                  [App\Controllers\Api\DiagramController::class, 'create']);
$router->get('/api/diagrams/{slug}',            [App\Controllers\Api\DiagramController::class, 'show']);
$router->post('/api/diagrams/{slug}',           [App\Controllers\Api\DiagramController::class, 'save']);
$router->patch('/api/diagrams/{slug}/draft',    [App\Controllers\Api\DiagramController::class, 'saveDraft']);
$router->patch('/api/diagrams/{slug}',          [App\Controllers\Api\DiagramController::class, 'patch']);
$router->delete('/api/diagrams/{slug}',         [App\Controllers\Api\DiagramController::class, 'delete']);
$router->get('/api/diagrams/{slug}/history',    [App\Controllers\Api\DiagramController::class, 'history']);
$router->get('/api/diagrams/{slug}/siblings',   [App\Controllers\Api\DiagramController::class, 'siblings']);
$router->post('/api/diagrams/{slug}/checkout',  [App\Controllers\Api\DiagramController::class, 'checkout']);
$router->post('/api/diagrams/{slug}/restore',   [App\Controllers\Api\DiagramController::class, 'restore']);
$router->post('/api/diagrams/{slug}/move',      [App\Controllers\Api\DiagramController::class, 'move']);
$router->post('/api/diagrams/{slug}/duplicate', [App\Controllers\Api\DiagramController::class, 'duplicate']);

// Projects (folders grouping the owner's diagrams)
$router->get('/api/projects',           [App\Controllers\Api\ProjectController::class, 'index']);
$router->post('/api/projects',          [App\Controllers\Api\ProjectController::class, 'create']);
$router->patch('/api/projects/{slug}',  [App\Controllers\Api\ProjectController::class, 'patch']);
$router->delete('/api/projects/{slug}', [App\Controllers\Api\ProjectController::class, 'delete']);
$router->get('/api/projects/{slug}/shares',              [App\Controllers\Api\ProjectShareController::class, 'index']);
$router->post('/api/projects/{slug}/shares',             [App\Controllers\Api\ProjectShareController::class, 'create']);
$router->delete('/api/projects/{slug}/shares/{user_id}', [App\Controllers\Api\ProjectShareController::class, 'delete']);

// Presence-driven scepter
$router->post('/api/diagrams/{slug}/presence',           [App\Controllers\Api\PresenceController::class, 'join']);
$router->post('/api/diagrams/{slug}/presence/heartbeat', [App\Controllers\Api\PresenceController::class, 'heartbeat']);
$router->post('/api/diagrams/{slug}/presence/selection', [App\Controllers\Api\PresenceController::class, 'selection']);
$router->post('/api/diagrams/{slug}/presence/leave',     [App\Controllers\Api\PresenceController::class, 'leave']);

$router->post('/api/diagrams/{slug}/edit-requests',                  [App\Controllers\Api\EditRequestController::class, 'create']);
$router->get('/api/diagrams/{slug}/edit-requests',                   [App\Controllers\Api\EditRequestController::class, 'listForDiagram']);
$router->get('/api/diagrams/{slug}/edit-requests/mine',              [App\Controllers\Api\EditRequestController::class, 'mine']);
$router->post('/api/diagrams/{slug}/edit-requests/{id}/accept',      [App\Controllers\Api\EditRequestController::class, 'accept']);
$router->post('/api/diagrams/{slug}/edit-requests/{id}/decline',     [App\Controllers\Api\EditRequestController::class, 'decline']);
$router->delete('/api/diagrams/{slug}/edit-requests/{id}',           [App\Controllers\Api\EditRequestController::class, 'cancel']);

// Merge requests: publish a fork (variant) onto the diagram it was forked from.
// {slug} is the variant for create/mine/withdraw, the original for list/accept/decline.
$router->post('/api/diagrams/{slug}/merge-requests',                 [App\Controllers\Api\MergeRequestController::class, 'create']);
$router->get('/api/diagrams/{slug}/merge-requests/mine',             [App\Controllers\Api\MergeRequestController::class, 'mine']);
$router->get('/api/diagrams/{slug}/merge-requests',                  [App\Controllers\Api\MergeRequestController::class, 'listForDiagram']);
$router->post('/api/diagrams/{slug}/merge-requests/{id}/accept',     [App\Controllers\Api\MergeRequestController::class, 'accept']);
$router->post('/api/diagrams/{slug}/merge-requests/{id}/decline',    [App\Controllers\Api\MergeRequestController::class, 'decline']);
$router->delete('/api/diagrams/{slug}/merge-requests/{id}',          [App\Controllers\Api\MergeRequestController::class, 'withdraw']);

$router->get('/api/diagrams/{slug}/shares',              [App\Controllers\Api\ShareController::class, 'index']);
$router->post('/api/diagrams/{slug}/shares',             [App\Controllers\Api\ShareController::class, 'create']);
$router->delete('/api/diagrams/{slug}/shares/{user_id}', [App\Controllers\Api\ShareController::class, 'delete']);

// MCP HTTP endpoint (Bearer-token authenticated, no CSRF; JSON-RPC 2.0)
$router->post('/mcp',     [App\Controllers\Api\McpController::class, 'handle']);
$router->add('OPTIONS', '/mcp', [App\Controllers\Api\McpController::class, 'handle']);

$router->dispatch();
