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
