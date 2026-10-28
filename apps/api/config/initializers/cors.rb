# frozen_string_literal: true

# Be sure to restart your server when you modify this file.

# Allowed origins come from the environment (comma separated). Production values are decided per deployment.
allowed_origins = ENV.fetch("CORS_ALLOWED_ORIGINS", "").split(",").map(&:strip).reject(&:empty?)

if allowed_origins.any?
  Rails.application.config.middleware.insert_before 0, Rack::Cors do
    allow do
      origins(*allowed_origins)

      resource "*",
               headers: :any,
               methods: %i[get post put patch delete options head]
    end
  end
end
