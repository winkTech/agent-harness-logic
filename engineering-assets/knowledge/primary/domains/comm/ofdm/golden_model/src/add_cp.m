function cp_sym = add_cp(time_sym, N_cp)
%% 添加循环前缀
%  输入: time_sym - IFFT输出 [N x N_sym]
%        N_cp    - CP长度
%  输出: cp_sym  - 加CP后的符号 [(N+N_cp) x N_sym]

    N = size(time_sym, 1);
    N_sym = size(time_sym, 2);
    cp_sym = zeros(N + N_cp, N_sym);

    for sym_idx = 1:N_sym
        % 取尾部N_cp个样点作为CP
        cp = time_sym(end-N_cp+1:end, sym_idx);
        % CP + 原始符号
        cp_sym(:, sym_idx) = [cp; time_sym(:, sym_idx)];
    end
end
