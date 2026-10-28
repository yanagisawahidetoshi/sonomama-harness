# frozen_string_literal: true

require "rails_helper"

RSpec.describe "Health check", type: :request do
  describe "GET /up" do
    context "when the application boots" do
      it "returns 200 so containers and load balancers can treat it as live" do
        get "/up"

        expect(response).to have_http_status(:ok)
      end
    end
  end
end
