<?php
declare(strict_types=1);

namespace App;

use PDO;
use RuntimeException;

final class Db
{
    private static ?PDO $pdo = null;

    public static function connect(): PDO
    {
        if (self::$pdo instanceof PDO) {
            return self::$pdo;
        }

        $driver = Config::get('DB_DRIVER', 'sqlite');

        if ($driver === 'sqlite') {
            $path = Config::get('DB_SQLITE_PATH', 'data/aquata.sqlite');
            if (!str_starts_with($path, '/')) {
                $path = dirname(__DIR__) . '/' . $path;
            }
            $dir = dirname($path);
            if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
                throw new RuntimeException("Cannot create data dir: $dir");
            }
            $pdo = new PDO('sqlite:' . $path);
            $pdo->exec('PRAGMA foreign_keys = ON');
            $pdo->exec('PRAGMA journal_mode = WAL');
        } elseif ($driver === 'mysql') {
            $host = Config::get('DB_HOST', 'localhost');
            $port = Config::int('DB_PORT', 3306);
            $name = Config::get('DB_NAME') ?? throw new RuntimeException('DB_NAME required for mysql');
            $user = Config::get('DB_USER') ?? throw new RuntimeException('DB_USER required for mysql');
            $pass = Config::get('DB_PASS', '');
            $dsn = "mysql:host=$host;port=$port;dbname=$name;charset=utf8mb4";
            $pdo = new PDO($dsn, $user, $pass);
        } else {
            throw new RuntimeException("Unknown DB_DRIVER: $driver");
        }

        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $pdo->setAttribute(PDO::ATTR_EMULATE_PREPARES, false);

        self::$pdo = $pdo;
        return $pdo;
    }

    public static function driver(): string
    {
        return Config::get('DB_DRIVER', 'sqlite');
    }
}
