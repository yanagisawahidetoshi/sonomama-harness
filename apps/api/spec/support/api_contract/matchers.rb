# frozen_string_literal: true

module ApiContract
  module Matchers
    extend RSpec::Matchers::DSL

    # expect(response).to match_api_contract
    #   the request and the response follow the contract
    # expect(response).to match_api_contract(request: { invalid: "/grade" })
    # expect(response).to match_api_contract(request: { invalid: :missing_required_body })
    #   a negative spec: the request violates the contract at that pointer (or in that category, see
    #   RequestViolation::CATEGORIES), and Rails answers with a declared 4xx error that follows the contract
    matcher :match_api_contract do |contract = nil, request: :valid|
      match do |response|
        expected_violation unless request == :valid
        subject_contract = contract || ApiContract.default
        @result = subject_contract.check(response.request, response)
        matched = problems.empty?
        # Coverage counts a passing check only: the operation was resolved, the response followed the contract and, for
        # a negative spec, the expected violation was detected and Rails answered with a declared 4xx error.
        # A failed check (or not_to match_api_contract) never counts.
        ApiContract.record(subject_contract, @result.operation) if matched
        matched
      end

      define_method(:expected_violation) do
        target = request[:invalid] if request.is_a?(Hash)
        return target if target.is_a?(String) || RequestViolation::CATEGORIES.include?(target)

        raise ArgumentError, "request: must be :valid or { invalid: \"/pointer\" } or { invalid: <category> } " \
                             "with a category of #{RequestViolation::CATEGORIES.join(', ')}; got #{request.inspect}"
      end

      define_method(:problems) do
        return ["#{@result.operation} is not defined in the contract"] if @result.undefined
        return @result.request_violations + @result.response_violations if request == :valid

        negative_problems + @result.response_violations
      end

      define_method(:negative_problems) do
        error = (400..499).cover?(@result.status) ? [] : ["an invalid request must get a declared 4xx error response"]
        undetected_violation + error
      end

      # The violations that were detected instead are listed, so a forgotten as: :json is easy to spot.
      define_method(:undetected_violation) do
        target = expected_violation
        key = target.is_a?(String) ? :pointer : :category
        return [] if @result.request_violations.any? { |violation| violation.public_send(key) == target }

        ["the spec declared an invalid request (#{target.inspect}), but it was not detected",
         *@result.request_violations.map(&:to_s)]
      end

      failure_message do
        "API contract violation in #{@result.operation} -> #{@result.status}:\n#{problems.join("\n").indent(2)}"
      end
    end
  end
end
