# frozen_string_literal: true

module ApiContract
  # Which Rails business routes a request spec checked against the contract. Path parameters are compared by position,
  # as in tools/harness/api-contract.mjs: Rails names them :id while OpenAPI names them {studentId}.
  class Coverage
    FRAMEWORK_CONTROLLERS = %r{\A(?:rails|active_storage|action_mailbox|action_cable)/}
    MISSING = "packages/api-schema/openapi.yaml does not exist"

    def initialize(contract:, routes:)
      @contract = contract
      @routes = routes.reject { |route| route["controller"].to_s.match?(FRAMEWORK_CONTROLLERS) }
      @covered = Hash.new { |covered, operation| covered[operation] = [] }
    end

    def record(operation, location)
      @covered[operation] |= [location]
    end

    # Returns the report lines, or raises CoverageError with them when a business route was not checked.
    def verify!
      return no_contract if @contract.nil?

      checked = endpoints.map { |verb, route| check(verb, route) }
      lines = checked.map(&:first) + unimplemented(checked.filter_map(&:last))
      raise CoverageError, lines.join("\n") if lines.any? { |line| line.start_with?("UNDEFINED", "UNCOVERED") }

      lines
    end

    private

    def no_contract
      targets = @routes.map { |route| target(route) }
      raise CoverageError, "#{MISSING}; Rails business routes cannot be checked: #{targets.join(', ')}" if targets.any?

      ["API contract: NOT CHECKED (#{MISSING} and Rails has no business route)"]
    end

    def unimplemented(implemented)
      (@contract.operations - implemented).map { |operation| "UNIMPLEMENTED #{operation}" }
    end

    def endpoints
      @routes.flat_map { |route| route["verb"].to_s.split("|").map { |verb| [verb, route] } }
    end

    def check(verb, route)
      operation = operation_for(verb, route["path"])
      return ["UNDEFINED #{verb} #{route['path']} (#{target(route)}) is not in the contract", nil] unless operation

      specs = @covered[operation]
      return ["UNCOVERED #{operation} (#{target(route)}) has no contract-checked spec", operation] if specs.empty?

      ["COVERED #{operation} (#{target(route)}) by #{specs.join(', ')}", operation]
    end

    def operation_for(verb, rails_path)
      path = rails_path.delete_suffix("(.:format)").gsub(/[:*][A-Za-z_]\w*/, "{}")
      @contract.operations.find { |operation| operation.gsub(/\{[^}]+\}/, "{}") == "#{verb} #{path}" }
    end

    def target(route) = "#{route['controller']}##{route['action']}"
  end
end
