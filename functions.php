<?php
/**
 * Amy Theme Functions
 */

// Theme setup
function amy_theme_setup() {
    // Add theme support
    add_theme_support('title-tag');
    add_theme_support('custom-logo');
    add_theme_support('post-thumbnails');

    // Remove admin bar for clean frontend
    add_filter('show_admin_bar', '__return_false');
}
add_action('after_setup_theme', 'amy_theme_setup');

// Enqueue styles and scripts
function amy_enqueue_assets() {
    $theme_version = '1.0.0';
    $theme_uri = get_template_directory_uri();

    // Enqueue Tailwind CSS
    wp_enqueue_style('amy-tailwind', $theme_uri . '/tailwind-output.css', array(), $theme_version);

    // Enqueue main stylesheet
    wp_enqueue_style('amy-style', $theme_uri . '/style.css', array('amy-tailwind'), $theme_version);

    // Enqueue main JavaScript
    wp_enqueue_script('amy-main', $theme_uri . '/index.js', array(), $theme_version, true);
}
add_action('wp_enqueue_scripts', 'amy_enqueue_assets');

// Remove WordPress emoji scripts
remove_action('wp_head', 'print_emoji_detection_script', 7);
remove_action('wp_print_styles', 'print_emoji_styles');

// Clean up WordPress head
remove_action('wp_head', 'wp_generator');
remove_action('wp_head', 'wlwmanifest_link');
remove_action('wp_head', 'rsd_link');

// Disable WordPress default styles
function amy_dequeue_wp_styles() {
    wp_dequeue_style('wp-block-library');
    wp_dequeue_style('wp-block-library-theme');
    wp_dequeue_style('global-styles');
}
add_action('wp_enqueue_scripts', 'amy_dequeue_wp_styles', 100);

// Automatic page routing - no manual page creation needed!
function amy_custom_routing() {
    $request_path = trim(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH), '/');

    // Map of URLs to template files
    $routes = array(
        '' => 'index.php',
        'profile' => 'profile.php',
        'leaderboard' => 'leaderboard.php',
        'earn' => 'earn.php',
        'points' => 'points.php',
        'contact' => 'contact.php'
    );

    // Check if the requested path matches a route
    if (array_key_exists($request_path, $routes)) {
        $template = locate_template($routes[$request_path]);
        if ($template) {
            // Disable WordPress default query
            global $wp_query;
            $wp_query->is_404 = false;
            $wp_query->is_page = true;
            $wp_query->is_singular = true;
            $wp_query->is_home = false;

            // Load the template
            include($template);
            exit;
        }
    }
}
add_action('template_redirect', 'amy_custom_routing', 1);

// Fix permalink structure for custom routes
function amy_add_rewrite_rules() {
    add_rewrite_rule('^profile/?$', 'index.php?amy_page=profile', 'top');
    add_rewrite_rule('^leaderboard/?$', 'index.php?amy_page=leaderboard', 'top');
    add_rewrite_rule('^earn/?$', 'index.php?amy_page=earn', 'top');
    add_rewrite_rule('^points/?$', 'index.php?amy_page=points', 'top');
    add_rewrite_rule('^contact/?$', 'index.php?amy_page=contact', 'top');
}
add_action('init', 'amy_add_rewrite_rules');

// Register custom query var
function amy_query_vars($vars) {
    $vars[] = 'amy_page';
    return $vars;
}
add_filter('query_vars', 'amy_query_vars');

// Flush rewrite rules on theme activation (one time only)
function amy_rewrite_flush() {
    amy_add_rewrite_rules();
    flush_rewrite_rules();
}
register_activation_hook(__FILE__, 'amy_rewrite_flush');
