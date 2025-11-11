<?php
/**
 * Theme Activation Helper
 * Visit this file ONCE after uploading: https://amyonbera.com/wp-content/themes/amy/activate-theme.php
 * This will flush rewrite rules so your custom URLs work.
 * After visiting, you can delete this file.
 */

// Load WordPress
require_once('../../../wp-load.php');

// Flush rewrite rules
flush_rewrite_rules();

?>
<!DOCTYPE html>
<html>
<head>
    <title>Amy Theme Activated!</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
        }
        .container {
            background: white;
            padding: 40px;
            border-radius: 10px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.3);
            text-align: center;
            max-width: 500px;
        }
        h1 {
            color: #FF1493;
            margin-bottom: 20px;
        }
        .success {
            color: #10b981;
            font-size: 48px;
            margin-bottom: 20px;
        }
        p {
            color: #666;
            line-height: 1.6;
        }
        a {
            display: inline-block;
            margin-top: 20px;
            padding: 12px 30px;
            background: #FF1493;
            color: white;
            text-decoration: none;
            border-radius: 25px;
            font-weight: bold;
        }
        a:hover {
            background: #d10f7a;
        }
        .note {
            background: #fef3c7;
            padding: 15px;
            border-radius: 5px;
            margin-top: 20px;
            font-size: 14px;
            color: #92400e;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="success">✅</div>
        <h1>Theme Activated Successfully!</h1>
        <p>Your custom URLs are now working. You can now visit:</p>
        <ul style="text-align: left; display: inline-block; margin: 20px 0;">
            <li><strong>/</strong> - Homepage</li>
            <li><strong>/profile</strong> - Profile page</li>
            <li><strong>/leaderboard</strong> - Leaderboard</li>
            <li><strong>/earn</strong> - Earn on Bera</li>
            <li><strong>/points</strong> - Amy Points</li>
            <li><strong>/contact</strong> - Contact</li>
        </ul>
        <a href="/">Go to Homepage</a>
        <div class="note">
            <strong>Note:</strong> You can now delete this file (activate-theme.php) from your server. It's no longer needed.
        </div>
    </div>
</body>
</html>
