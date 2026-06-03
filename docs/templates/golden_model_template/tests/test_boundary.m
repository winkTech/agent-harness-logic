function pass = test_boundary()
% 测试用例: 边界条件
% 验证算法在极值输入下的稳定性
    cfg = config();

    x_zero = zeros(cfg.N, 1);
    y_zero = tx_chain(x_zero, cfg);
    pass_zero = verify_output(y_zero);

    x_max = ones(cfg.N, 1) * realmax('single');
    y_max = tx_chain(x_max, cfg);
    pass_max = verify_output(y_max);

    pass = pass_zero && pass_max;
    if ~pass
        warning('边界条件测试失败');
    end
end

function pass = verify_output(y)
    pass = ~any(isnan(y(:))) && ~any(isinf(y(:)));
end
