CREATE DATABASE IF NOT EXISTS audora;
USE audora;

CREATE TABLE IF NOT EXISTS site_visitors (
  visitor_id CHAR(36) NOT NULL PRIMARY KEY,
  first_seen DATETIME(6) NOT NULL,
  last_seen DATETIME(6) NOT NULL,
  KEY site_visitors_first_seen_idx (first_seen)
);

CREATE TABLE IF NOT EXISTS feedback_submissions (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  submission_token CHAR(36) NOT NULL,
  name VARCHAR(80) NOT NULL,
  email VARCHAR(254) NULL,
  role VARCHAR(100) NULL,
  rating TINYINT NOT NULL,
  message TEXT NOT NULL,
  consent_to_publish BOOLEAN NOT NULL DEFAULT FALSE,
  status ENUM('pending', 'published', 'rejected') NOT NULL DEFAULT 'pending',
  created_at DATETIME(6) NOT NULL,
  published_at DATETIME(6) NULL,
  UNIQUE KEY feedback_submission_token_idx (submission_token),
  KEY feedback_publication_idx (status, consent_to_publish, published_at)
);
