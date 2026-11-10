function [y] = rx_chain(x, cfg)
% <算法> 接收链路
% 输入:
%   x   - 接收信号
%   cfg - 配置结构体
% 输出:
%   y   - 解调数据

    %% 模块A
    sig_a = module_a(x, cfg);

    %% 模块B
    sig_b = module_b(sig_a, cfg);

    %% 模块C
    y = module_c(sig_b, cfg);

end

%% ===== 子模块 =====

function y = module_a(x, cfg)
    % 模块A 实现
    y = x;  % TODO
end

function y = module_b(x, cfg)
    % 模块B 实现
    y = x;  % TODO
end

function y = module_c(x, cfg)
    % 模块C 实现
    y = x;  % TODO
end
