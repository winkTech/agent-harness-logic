function pass = test_normal()
% 测试用例: 常规数据
% 验证算法在典型输入下的正确性
    cfg = config();

    x = generate_test_data(cfg.N, 'random');
    y = tx_chain(x, cfg);
    pass = verify_output(y, cfg);

    if ~pass
        warning('常规数据测试失败');
    end
end

function data = generate_test_data(N, type)
    switch type
        case 'random'
            data = complex(randn(N,1), randn(N,1));
        otherwise
            data = zeros(N,1);
    end
end

function pass = verify_output(y, cfg)
    pass = ~any(isnan(y(:))) && ~any(isinf(y(:)));
end
