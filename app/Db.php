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
            $opts = [];
            // PDO::MYSQL_ATTR_INIT_COMMAND only exists when pdo_mysql is loaded.
            // Some shared hosts run CLI php without it; guard the constant.
            //
            // time_zone='+00:00' is critical: the app generates cutoff/past
            // timestamps with gmdate() (UTC) and compares them to TIMESTAMP
            // columns. Without this, MariaDB interprets bound strings in the
            // server's local time zone, double-converting them and skewing
            // all presence/idle/expiry comparisons by the local offset.
            if (defined('PDO::MYSQL_ATTR_INIT_COMMAND')) {
                $opts[constant('PDO::MYSQL_ATTR_INIT_COMMAND')] =
                    "SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci, "
                    . "sql_mode='STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION,ERROR_FOR_DIVISION_BY_ZERO,NO_ZERO_DATE,NO_ZERO_IN_DATE', "
                    . "time_zone='+00:00'";
            }
            $pdo = new PDO($dsn, $user, $pass, $opts);
            if ($opts === []) {
                // Fallback: run the same SET after connect.
                $pdo->exec("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
                $pdo->exec("SET SESSION sql_mode='STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION,ERROR_FOR_DIVISION_BY_ZERO,NO_ZERO_DATE,NO_ZERO_IN_DATE'");
                $pdo->exec("SET time_zone='+00:00'");
            }
        } else {
            throw new RuntimeException("Unknown DB_DRIVER: $driver");
        }

        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $pdo->setAttribute(PDO::ATTR_EMULATE_PREPARES, false);

        self::$pdo = $pdo;
        Schema::ensure($pdo);
        return $pdo;
    }

    public static function driver(): string
    {
        return Config::get('DB_DRIVER', 'sqlite');
    }
}
