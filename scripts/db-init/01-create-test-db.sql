-- Runs once when the docker-compose volume is first created.
-- The integration-test database is separate from personal_os_dev so tests can
-- reset it freely without ever touching development data.
CREATE DATABASE personal_os_test;
