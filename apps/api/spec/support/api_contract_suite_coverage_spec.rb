# frozen_string_literal: true

require "open3"
require "rails_helper"

RSpec.describe ApiContract do
  describe ".verify_suite_coverage" do
    let(:configuration) do
      RSpec::Core::Configuration.new.tap { |configuration| configuration.filter_run_including(focus: true) }
    end

    around do |example|
      previous = ENV.fetch("API_CONTRACT_COVERAGE", nil)
      example.run
    ensure
      ENV["API_CONTRACT_COVERAGE"] = previous
    end

    context "when the rails Verifier requires coverage and a filter limits the examples" do
      it "fails, because the Verifier's run must not silently check only part of the suite" do
        ENV["API_CONTRACT_COVERAGE"] = "required"

        expect { described_class.verify_suite_coverage(configuration) }
          .to raise_error(ApiContract::CoverageError, /only part of the suite/)
      end
    end

    context "when the rails Verifier requires coverage and rspec runs as a dry run" do
      it "fails, because a dry run never checks the contract" do
        env = { "API_CONTRACT_COVERAGE" => "required" }
        _, status = Open3.capture2e(env, "bundle", "exec", "rspec", "--dry-run", "spec/lib/route_manifest_spec.rb")

        expect(status).not_to be_success
      end
    end

    context "when a developer runs part of the suite" do
      it "reports that coverage was not checked" do
        ENV.delete("API_CONTRACT_COVERAGE")

        expect(described_class.verify_suite_coverage(configuration))
          .to contain_exactly(a_string_including("NOT CHECKED"))
      end
    end
  end
end
